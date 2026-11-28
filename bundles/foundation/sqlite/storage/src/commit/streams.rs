//! The stream items of [`super::apply`]'s write transaction, after the puts
//! and in this order: the drops, the truncate, the appends, then the
//! truncate's mark, whose `at_sequence` is the stream's head after the
//! appends. Every head is read from the transaction, which sees its own
//! writes.

use doric_bundle::ContractError;
use doric_sqlite::WriteTxn;
use prost::Message as _;

use super::{
    Entry,
    transaction::{detailed, internal},
};
use crate::{
    layout::{self, CHUNK_BYTES, StreamEntryHeader, StreamHead, TruncationMark},
    streams::{last_sequence, past_end},
};

/// The kinds of a stream's records that hold its entries.
const ENTRY_KINDS: [&str; 2] = ["stream.entry", "stream.chunk"];

/// Applies the stream items of `entries`, under `bundle`'s prefix, in `txn`:
/// each drop removes the stream's head, entries, chunks and marks; the
/// truncate removes the entries above its `after`; each append checks its
/// `expected` sequence, then writes its events at the next sequences, each
/// with `created_at`, and the stream's new head; then the truncate's mark at
/// [`WriteTxn::position`].
///
/// # Errors
///
/// `invalid_input` (details `{stream, afterSequence, lastSequence}`) for a
/// truncate past the stream's last sequence, after the drops;
/// `sequence_conflict` (details `{stream, expected, actual}`) for an append
/// whose expected sequence is not the stream's, after the earlier appends;
/// `internal` for a stored head that does not decode or a sequence past
/// `u32::MAX`; the errors of the transaction.
pub(super) fn write(
    txn: &mut dyn WriteTxn,
    bundle: &str,
    entries: &[Entry],
    created_at: &str,
) -> Result<(), ContractError> {
    for entry in entries {
        if let Entry::DropStream { stream } = entry {
            let head = layout::head(bundle, stream);
            txn.delete(&head)?;
            for kind in ENTRY_KINDS.into_iter().chain(["stream.mark"]) {
                let range = layout::under(bundle, &[kind, stream]);
                txn.clear_range(&range.start, &range.end)?;
            }
        }
    }

    let mut mark = None;
    for entry in entries {
        if let Entry::Truncate { stream, after } = entry {
            let last = last_sequence(txn, &layout::head(bundle, stream))?;
            if *after > last {
                return Err(past_end(stream, "truncated", *after, last));
            }
            if let Some(first) = after.checked_add(1) {
                for kind in ENTRY_KINDS {
                    let range = layout::entries_from(bundle, kind, stream, first);
                    txn.clear_range(&range.start, &range.end)?;
                }
            }
            mark = Some((stream, *after));
        }
    }

    for entry in entries {
        if let Entry::Append {
            stream,
            expected,
            events,
        } = entry
        {
            append(txn, bundle, stream, *expected, events, created_at)?;
        }
    }

    if let Some((stream, after)) = mark {
        let at = last_sequence(txn, &layout::head(bundle, stream))?;
        let mark = TruncationMark {
            after_sequence: after,
            at_sequence: at,
        };
        let key = layout::mark(bundle, stream, txn.position());
        txn.put(&key, &mark.encode_to_vec())?;
    }
    Ok(())
}

/// Appends `events` to `stream` after its head, which must be `expected`
/// when it is `Some`, and writes the new head.
fn append(
    txn: &mut dyn WriteTxn,
    bundle: &str,
    stream: &str,
    expected: Option<u32>,
    events: &[Vec<u8>],
    created_at: &str,
) -> Result<(), ContractError> {
    let head = layout::head(bundle, stream);
    let mut last = last_sequence(txn, &head)?;
    if let Some(expected) = expected
        && expected != last
    {
        return Err(detailed(
            "sequence_conflict",
            format!("Stream {stream} is at sequence {last}, not {expected}."),
            [
                ("stream", stream.into()),
                ("expected", f64::from(expected).into()),
                ("actual", f64::from(last).into()),
            ],
        ));
    }
    for event in events {
        last = last.checked_add(1).ok_or_else(|| {
            internal(format!(
                "The stream {stream} has no sequence after {}.",
                u32::MAX
            ))
        })?;
        let first = event.len().min(CHUNK_BYTES);
        let mut chunk_count = 0;
        for part in event[first..].chunks(CHUNK_BYTES) {
            chunk_count += 1;
            txn.put(
                &layout::entry_chunk(bundle, stream, last, chunk_count),
                part,
            )?;
        }
        let header = StreamEntryHeader {
            created_at: created_at.to_owned(),
            value_size: u32::try_from(event.len()).expect("an event holds at most 3 MiB"),
            chunk_count,
            chunk: event[..first].to_vec(),
        };
        txn.put(
            &layout::entry(bundle, stream, last),
            &header.encode_to_vec(),
        )?;
    }
    let stored = StreamHead {
        last_sequence: last,
    };
    txn.put(&head, &stored.encode_to_vec())?;
    Ok(())
}
