//! `storage/v2.Commit` for documents (spec "The storage contract", "Commit"):
//! the items of one call, checked as they arrive and before any I/O
//! ([`Batch`]), then applied all or none ([`apply`]), stream items after the
//! documents ([`streams`]).

mod streams;
pub(crate) mod transaction;

use std::{
    sync::{
        Arc,
        atomic::{AtomicU64, Ordering},
    },
    time::{SystemTime, UNIX_EPOCH},
};

use doric_bundle::ContractError;
use doric_sqlite::{KvEngine, refusal};

use crate::{
    cache::Headers,
    layout,
    schema::Pools,
    streams::{checked, whole_sequence},
    v2::{CommitRequest, commit_request::Item},
};

/// The most items of one batch, `expect`, `put`, `delete`, `drop_stream`,
/// `truncate` and `event` (`details.limit` `"batch"`); `chunk` and `append`
/// items do not count.
pub const ITEMS: usize = 10_000;
/// The most bytes of all the values of one batch, the sum of its chunks and
/// events (`details.limit` `"batch"`).
pub const BATCH_BYTES: usize = 67_108_864;
/// The most bytes of one document's value, the sum of its put's chunks
/// (`details.limit` `"document"`).
pub const DOCUMENT_BYTES: usize = 16_777_216;
/// The most bytes of one `chunk` item.
pub const PART_BYTES: usize = 1_048_576;
/// The most bytes of one appended event, its `event` item and the chunks
/// after it (`details.limit` `"append"`).
pub const APPEND_BYTES: usize = 3_145_728;

/// The items of one `Commit` call for the bundle `bundle`, taken one by one as
/// they arrive ([`Batch::push`]); each is checked before the next is read, and
/// none touches the store.
#[derive(Debug)]
pub struct Batch {
    items: Items,
    count: usize,
    bytes: usize,
}

/// A checked batch, ready for [`apply`]: its bundle, and its expects, puts,
/// each with its whole value, and deletes, in arrival order. Every type and id
/// in it is the bundle's and within its limits, and it holds 1 to [`ITEMS`]
/// items and at most [`BATCH_BYTES`] bytes of values.
#[derive(Debug, Clone)]
pub struct Items {
    bundle: String,
    entries: Vec<Entry>,
}

/// One item of [`Items`]; an append holds its events.
#[derive(Debug, Clone)]
enum Entry {
    Expect {
        type_id: String,
        id: String,
        revision: u32,
    },
    Put {
        type_id: String,
        id: String,
        value: Vec<u8>,
    },
    Delete {
        type_id: String,
        id: String,
    },
    DropStream {
        stream: String,
    },
    Truncate {
        stream: String,
        after: u32,
    },
    Append {
        stream: String,
        expected: Option<u32>,
        events: Vec<Vec<u8>>,
    },
}

impl Batch {
    /// An empty batch of the bundle `bundle`, the caller's
    /// ([`crate::bundle`]).
    pub fn new(bundle: &str) -> Self {
        Self {
            items: Items {
                bundle: bundle.to_owned(),
                entries: Vec::new(),
            },
            count: 0,
            bytes: 0,
        }
    }

    /// Takes `request`, the next item of the call. A `chunk` appends its bytes
    /// to the value of the put or the event before it; a put with no chunk
    /// has an empty value. An `event` is the next event of the append before
    /// it.
    ///
    /// # Errors
    ///
    /// The first refusal, checked in this order; the batch is then to be
    /// dropped, and nothing has been written:
    ///
    /// 1. `invalid_input` for an item with no case set;
    /// 2. `invalid_input`, message `An append needs at least one event.`
    ///    (detail `stream`), for an item other than `event` after an `append`;
    /// 3. `invalid_input` for an `event` that follows no `append` or event,
    ///    and for a `chunk` that follows no `put` or event;
    /// 4. `invalid_input` for a `chunk` or `event` of 0 bytes or over
    ///    [`PART_BYTES`];
    /// 5. for an `expect`, `put` or `delete`, the errors of
    ///    [`crate::layout::checked`] with the batch's bundle as owner: the
    ///    type's length, then its namespace (`not_owner`), then the id's
    ///    length; for a `drop_stream`, `truncate` or `append`, the errors of
    ///    [`crate::streams::checked`];
    /// 6. `invalid_input` for an `expect` whose revision, a `truncate`'s
    ///    `after_sequence` or an `append`'s `expected_sequence` that is not a
    ///    whole number from 0 to `u32::MAX`; then for a second `truncate`;
    /// 7. `limit_exceeded` (`details.limit` `"batch"`) for the counted item
    ///    after the [`ITEMS`]th;
    /// 8. for a `chunk` or `event`, `limit_exceeded` (`details.limit`
    ///    `"document"`) when its put's value would pass [`DOCUMENT_BYTES`], or
    ///    (`"append"`) its event [`APPEND_BYTES`], then (`"batch"`) when the
    ///    batch's values would pass [`BATCH_BYTES`].
    pub fn push(&mut self, request: CommitRequest) -> Result<(), ContractError> {
        let Some(item) = request.item else {
            return Err(ContractError::new(
                "invalid_input",
                "A batch item has no case set.",
            ));
        };
        if !matches!(item, Item::Event(_)) {
            self.no_empty_append()?;
        }
        let entry = match item {
            Item::Chunk(bytes) => return self.append(bytes, false),
            Item::Event(bytes) => return self.append(bytes, true),
            Item::DropStream(stream) => {
                checked(&self.items.bundle, &stream)?;
                Entry::DropStream { stream }
            }
            Item::Truncate(truncate) => {
                checked(&self.items.bundle, &truncate.stream)?;
                let after = whole_sequence(truncate.after_sequence, "afterSequence")?;
                let mut entries = self.items.entries.iter();
                if entries.any(|entry| matches!(entry, Entry::Truncate { .. })) {
                    return Err(ContractError::new(
                        "invalid_input",
                        "A batch holds at most one truncate.",
                    ));
                }
                Entry::Truncate {
                    stream: truncate.stream,
                    after,
                }
            }
            Item::Append(append) => {
                checked(&self.items.bundle, &append.stream)?;
                let expected = append
                    .expected_sequence
                    .map(|expected| whole_sequence(expected, "expectedSequence"))
                    .transpose()?;
                self.items.entries.push(Entry::Append {
                    stream: append.stream,
                    expected,
                    events: Vec::new(),
                });
                return Ok(());
            }
            Item::Expect(expect) => {
                layout::checked(&self.items.bundle, &expect.r#type, &expect.id)?;
                Entry::Expect {
                    revision: whole_revision(expect.revision)?,
                    type_id: expect.r#type,
                    id: expect.id,
                }
            }
            Item::Put(key) => {
                layout::checked(&self.items.bundle, &key.r#type, &key.id)?;
                Entry::Put {
                    type_id: key.r#type,
                    id: key.id,
                    value: Vec::new(),
                }
            }
            Item::Delete(key) => {
                layout::checked(&self.items.bundle, &key.r#type, &key.id)?;
                Entry::Delete {
                    type_id: key.r#type,
                    id: key.id,
                }
            }
        };
        self.count()?;
        self.items.entries.push(entry);
        Ok(())
    }

    /// Counts one more item toward [`ITEMS`].
    fn count(&mut self) -> Result<(), ContractError> {
        if self.count >= ITEMS {
            return Err(refusal(
                "limit_exceeded",
                format!("A batch holds at most {ITEMS} items."),
                "limit",
                "batch".into(),
            ));
        }
        self.count += 1;
        Ok(())
    }

    /// Refuses a batch whose last item is an `append` with no event.
    fn no_empty_append(&self) -> Result<(), ContractError> {
        match self.items.entries.last() {
            Some(Entry::Append { stream, events, .. }) if events.is_empty() => Err(refusal(
                "invalid_input",
                "An append needs at least one event.",
                "stream",
                stream.as_str().into(),
            )),
            _ => Ok(()),
        }
    }

    /// Takes `bytes`: with `event`, the first part of the next event of the
    /// append before it; otherwise the next part of the value of the put or
    /// the event before it.
    fn append(&mut self, bytes: Vec<u8>, event: bool) -> Result<(), ContractError> {
        let (kind, follows) = if event {
            ("An event", "an append or its events")
        } else {
            ("A chunk", "a put or an event")
        };
        let Some((limit, name, bound)) = (match self.items.entries.last() {
            Some(Entry::Put { .. }) if !event => {
                Some((DOCUMENT_BYTES, "A document's value", "document"))
            }
            Some(Entry::Append { events, .. }) if event || !events.is_empty() => {
                Some((APPEND_BYTES, "An event", "append"))
            }
            _ => None,
        }) else {
            return Err(ContractError::new(
                "invalid_input",
                format!("{kind} must follow {follows}."),
            ));
        };
        if bytes.is_empty() || bytes.len() > PART_BYTES {
            return Err(ContractError::new(
                "invalid_input",
                format!(
                    "{kind} holds 1 to {PART_BYTES} bytes; this one holds {}.",
                    bytes.len()
                ),
            ));
        }
        if event {
            self.count()?;
        }
        let value = match self.items.entries.last_mut() {
            Some(Entry::Put { value, .. }) => value,
            Some(Entry::Append { events, .. }) => {
                if event {
                    events.push(Vec::new());
                }
                events.last_mut().expect("an event to extend")
            }
            _ => unreachable!("the target is checked above"),
        };
        if value.len() + bytes.len() > limit {
            return Err(refusal(
                "limit_exceeded",
                format!("{name} holds at most {limit} bytes."),
                "limit",
                bound.into(),
            ));
        }
        if self.bytes + bytes.len() > BATCH_BYTES {
            return Err(refusal(
                "limit_exceeded",
                format!("A batch's values hold at most {BATCH_BYTES} bytes."),
                "limit",
                "batch".into(),
            ));
        }
        self.bytes += bytes.len();
        value.extend_from_slice(&bytes);
        Ok(())
    }

    /// The batch's items, once the call's stream has ended.
    ///
    /// # Errors
    ///
    /// `invalid_input` for a batch of no item, and for one that ends with an
    /// `append` with no event (message `An append needs at least one
    /// event.`, detail `stream`).
    pub fn finish(self) -> Result<Items, ContractError> {
        self.no_empty_append()?;
        if self.items.entries.is_empty() {
            return Err(ContractError::new(
                "invalid_input",
                "A batch holds at least one item.",
            ));
        }
        Ok(self.items)
    }
}

/// Applies `items` to `engine` under their bundle's prefix, all or none, and
/// answers the commit's position ([`KvEngine::write`]).
///
/// First, in one read transaction, for each item in batch order: its type's
/// stored declaration; then, for a put of a type with indexes, its value
/// decoded with the declaration's schema (whose pool `pools` caches, keyed by
/// the declaration's `schema`), its index values
/// ([`crate::schema::index_values`]) and its index keys
/// ([`crate::layout::index`]). A type without indexes is never decoded.
///
/// Then, in one write transaction: the declarations are read again, and the
/// index keys of a put whose declaration changed since the read are computed
/// again with the new one (never refused for the change itself). Then the
/// expects, the deletes and the puts, in that order, each kind in batch order:
///
/// - an expect holds when the document's revision, 0 when absent, is its
///   revision;
/// - a delete of a document removes its header, its chunks and the index keys
///   its header lists; of an absent document, nothing;
/// - a put writes the header with the next revision, the revision the
///   transaction sees plus 1 (1 for an absent document, so a delete then a put
///   of one id restarts at 1, and a second put of one id in a batch takes the
///   first's plus 1), its value in a header chunk of at most
///   [`crate::layout::CHUNK_BYTES`] bytes and the chunks after it, its index
///   keys, removing the keys of its last header it no longer has, and as
///   `updated_at` [`iso`]`(clock.tick(clock.now()))`, one value for the whole
///   commit, never below the value of an earlier commit of this process.
///
/// Then the stream items ([`streams`]): the drops, the truncate, the appends,
/// each entry taking the commit's `updated_at` as `createdAt`, and the
/// truncate's mark, at the stream's last sequence after the appends.
///
/// The write transaction reads and writes headers through `headers`
/// ([`Headers::begin`] first): it reads a header from the cache when it holds
/// one, from SQLite otherwise, and the cache holds, once the commit has
/// succeeded and before the next write, each put's new header and none of a
/// deleted document; an error leaves the cache as it was. The answer and the
/// stored state are the same with any bound, 0 included.
///
/// # Errors
///
/// Any error writes nothing. In the read transaction, for the first item in
/// batch order that fails: `unknown_type` (details `{type}`, message `Storage
/// type <type> is not defined.`) for a type with no stored declaration;
/// `invalid_input` for a put's value that does not decode, for a type with
/// indexes ([`crate::schema::json_form`]); then the
/// errors of `index_values` and of `layout::index` (`limit_exceeded`,
/// `details.limit` `"indexKey"`). In the write transaction, the same for a
/// recomputed put; then `revision_conflict` (details `{type, id, expected,
/// actual}`) for the first expect that does not hold; then
/// `unique_conflict` (details `{type, index}`) for the first put whose key
/// of a unique index another document holds at that moment, after the
/// batch's deletes and earlier puts; then `invalid_input` (details `{stream,
/// afterSequence, lastSequence}`) for a truncate past its stream's last
/// sequence, and `sequence_conflict` (details `{stream, expected, actual}`)
/// for the first append whose expected sequence does not hold. `internal`
/// for a stored declaration,
/// schema or header that does not decode, and the errors of
/// [`KvEngine::read`] and [`KvEngine::write`].
pub async fn apply<E: KvEngine>(
    engine: &E,
    clock: &Clock,
    pools: &Pools,
    headers: &Headers,
    items: Items,
) -> Result<f64, ContractError> {
    let items = Arc::new(items);
    let (read_items, read_pools) = (Arc::clone(&items), pools.clone());
    let planned = engine
        .read(move |txn| transaction::plan(txn, &read_pools, &read_items))
        .await?;
    let (clock, pools, headers) = (clock.clone(), pools.clone(), headers.clone());
    let ((), position) = engine
        .write(move |txn| transaction::write(txn, &clock, &pools, &headers, &items, planned))
        .await?;
    Ok(position)
}

/// `revision` as a whole number from 0 to `u32::MAX`.
fn whole_revision(revision: f64) -> Result<u32, ContractError> {
    if revision.fract() == 0.0 && (0.0..=f64::from(u32::MAX)).contains(&revision) {
        // A whole number within the range converts exactly.
        Ok(revision as u32)
    } else {
        Err(ContractError::new(
            "invalid_input",
            format!(
                "An expected revision is a whole number from 0 to {}; {revision} is not.",
                u32::MAX
            ),
        ))
    }
}

/// The engine's clock for `updatedAt`: milliseconds since the Unix epoch,
/// never below what it answered before. Monotonic only within one process:
/// it starts from the wall clock with each process. Clones share one memory.
#[derive(Debug, Default, Clone)]
pub struct Clock {
    last: Arc<AtomicU64>,
}

impl Clock {
    /// The wall clock, in milliseconds since the Unix epoch; 0 before it.
    pub fn now(&self) -> u64 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_or(0, |since| {
                u64::try_from(since.as_millis()).unwrap_or(u64::MAX)
            })
    }

    /// The greater of `now_ms` and the greatest value this clock or a clone
    /// answered before, which it then remembers: so its answers never go back,
    /// even when the wall clock does. Equal answers are allowed.
    pub fn tick(&self, now_ms: u64) -> u64 {
        self.last.fetch_max(now_ms, Ordering::SeqCst).max(now_ms)
    }
}

/// `ms`, milliseconds since the Unix epoch, as JavaScript's
/// `Date.prototype.toISOString` writes it, in UTC: `YYYY-MM-DDTHH:mm:ss.sssZ`
/// for the years 1970 to 9999 (`iso(0)` is `1970-01-01T00:00:00.000Z`), and
/// `+YYYYYY-MM-DDTHH:mm:ss.sssZ` after them.
pub fn iso(ms: u64) -> String {
    const DAY: u64 = 86_400_000;
    let (days, time) = (ms / DAY, ms % DAY);
    let (year, month, day) = civil(days);
    let year = if year <= 9999 {
        format!("{year:04}")
    } else {
        format!("+{year:06}")
    };
    format!(
        "{year}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{:03}Z",
        time / 3_600_000,
        time / 60_000 % 60,
        time / 1000 % 60,
        time % 1000
    )
}

/// The year, month and day of `days` days after 1970-01-01, in the proleptic
/// Gregorian calendar (Howard Hinnant's `civil_from_days`).
fn civil(days: u64) -> (u64, u64, u64) {
    let shifted = days + 719_468;
    let era = shifted / 146_097;
    let day_of_era = shifted % 146_097;
    let year_of_era =
        (day_of_era - day_of_era / 1460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let month_index = (5 * day_of_year + 2) / 153;
    let day = day_of_year - (153 * month_index + 2) / 5 + 1;
    let month = if month_index < 10 {
        month_index + 3
    } else {
        month_index - 9
    };
    let year = year_of_era + era * 400 + u64::from(month <= 2);
    (year, month, day)
}

#[cfg(test)]
mod tests;
