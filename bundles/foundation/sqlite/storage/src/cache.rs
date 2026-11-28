//! The cache of document headers (A80, RK38; spec "The storage contract",
//! "Cache"): the headers without their chunk that `Commit`'s and `Register`'s
//! write transactions read, kept in memory between transactions of the one
//! writer thread. A write transaction reads through a [`Staged`] overlay that
//! [`Headers::begin`] opens and [`Staged::finish`] applies once `COMMIT`
//! succeeds; a rollback drops its staged puts, removals and clean reads. A
//! cache hit inside the transaction still updates the LRU recency, which a
//! rollback does not undo; that changes only the eviction order. `Get` and
//! `Query` never use the cache. A [`Suspension`] ([`Headers::suspend`])
//! turns it off while a write it does not see runs, such as a
//! `storage.kv/v1` commit outside `doric/`.

use std::{
    collections::{BTreeMap, HashMap},
    ffi::OsStr,
    sync::{Arc, Mutex, MutexGuard, PoisonError},
};

use doric_bundle::ContractError;
use doric_sqlite::{ReadTxn, WriteTxn, refusal};

use crate::{documents::decode_header, layout::DocumentHeader};

/// The most bytes the bundle's cache holds, 64 MiB, counted as
/// [`ENTRY_BYTES`] describes.
pub const CACHE_BYTES: usize = 67_108_864;

/// What an entry counts beyond its key and its `index_keys`: an entry costs
/// its key's length, plus the lengths of its `index_keys`, plus this.
pub const ENTRY_BYTES: usize = 64;

/// The environment variable that turns the cache on or off
/// ([`Headers::from_setting`]).
pub const CACHE_VARIABLE: &str = "DORIC_SQLITE_CACHE";

/// A document header without its chunk: what a write transaction reads of a
/// stored [`DocumentHeader`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Header {
    /// The document's revision, at least 1.
    pub revision: u32,
    /// The bytes of the whole value.
    pub value_size: u32,
    /// The chunks after the header's, `("doc.chunk", type, id, 1..=n)`.
    pub chunk_count: u32,
    /// The document's index keys, without the bundle's prefix.
    pub index_keys: Vec<Vec<u8>>,
    /// The ISO time of the document's last put.
    pub updated_at: String,
}

impl From<DocumentHeader> for Header {
    /// `header` without its `chunk`; every other field as it is.
    fn from(header: DocumentHeader) -> Self {
        let DocumentHeader {
            revision,
            value_size,
            chunk_count,
            chunk: _,
            index_keys,
            updated_at,
        } = header;
        Self {
            revision,
            value_size,
            chunk_count,
            index_keys,
            updated_at,
        }
    }
}

/// The cache of document headers, keyed by
/// [`layout::document`](crate::layout::document)'s
/// `<bundle>/("doc", type, id)`.
///
/// It holds at most [`Headers::bound`] bytes, each entry counted as its key's
/// length, plus the lengths of its `index_keys`, plus [`ENTRY_BYTES`]; to make
/// room it evicts the least recently used entry first. An entry larger than
/// the bound is not cached, so a bound of 0 caches nothing and every
/// transaction reads SQLite. It never holds an absent document. Only the
/// writer thread changes it, through [`Staged::finish`]; clones share one
/// cache.
#[derive(Debug, Clone)]
pub struct Headers {
    bound: usize,
    entries: Arc<Mutex<Lru>>,
}

/// The entries of a [`Headers`] and their recency; its fields are the
/// implementation's.
#[derive(Debug, Default)]
struct Lru {
    /// Each cached header and the tick of its last use.
    entries: HashMap<Vec<u8>, (Header, u64)>,
    /// The keys by the tick of their last use, the least recent first.
    recency: BTreeMap<u64, Vec<u8>>,
    /// The tick of the next use.
    tick: u64,
    /// The bytes the entries count.
    bytes: usize,
    /// The [`Suspension`]s alive, those `mem::forget`-ed included: while it
    /// is above 0, [`Headers::begin`] clears the cache.
    suspended: usize,
}

impl Lru {
    /// What the entry of `key` with `header` counts.
    fn cost(key: &[u8], header: &Header) -> usize {
        key.len() + header.index_keys.iter().map(Vec::len).sum::<usize>() + ENTRY_BYTES
    }

    /// The next tick.
    fn next_tick(&mut self) -> u64 {
        let tick = self.tick;
        self.tick += 1;
        tick
    }

    /// The cached header of `key`, now the most recently used.
    fn get(&mut self, key: &[u8]) -> Option<Header> {
        let tick = self.next_tick();
        let (header, used) = self.entries.get_mut(key)?;
        let key = self.recency.remove(used).expect("every entry has a tick");
        *used = tick;
        self.recency.insert(tick, key);
        Some(header.clone())
    }

    /// Removes the entry of `key`, if any.
    fn remove(&mut self, key: &[u8]) {
        if let Some((header, used)) = self.entries.remove(key) {
            self.recency.remove(&used);
            self.bytes -= Self::cost(key, &header);
        }
    }

    /// Caches `header` as the most recently used entry of `key`, evicting the
    /// least recently used entries to stay within `bound`; an entry larger
    /// than `bound` is not cached.
    fn insert(&mut self, bound: usize, key: Vec<u8>, header: Header) {
        self.remove(&key);
        let cost = Self::cost(&key, &header);
        if cost > bound {
            return;
        }
        while self.bytes + cost > bound {
            let Some(oldest) = self.recency.values().next().cloned() else {
                break;
            };
            self.remove(&oldest);
        }
        let tick = self.next_tick();
        self.bytes += cost;
        self.recency.insert(tick, key.clone());
        self.entries.insert(key, (header, tick));
    }

    /// Removes every entry.
    fn clear(&mut self) {
        self.entries.clear();
        self.recency.clear();
        self.bytes = 0;
    }
}

impl Default for Headers {
    /// An empty cache bounded at [`CACHE_BYTES`], the bundle's.
    fn default() -> Self {
        Self::new(CACHE_BYTES)
    }
}

impl Headers {
    /// An empty cache of at most `bound` bytes; 0 caches nothing.
    pub fn new(bound: usize) -> Self {
        Self {
            bound,
            entries: Arc::default(),
        }
    }

    /// The cache that the value of [`CACHE_VARIABLE`] asks for: unset, empty
    /// or `1`, [`Headers::default`]; `0`, `Headers::new(0)`, which caches
    /// nothing.
    ///
    /// # Errors
    ///
    /// Any other value, one that is not UTF-8 included: `invalid_input`, the
    /// message `DORIC_SQLITE_CACHE is "0" or "1"; "<value>" is not.`, the
    /// value as [`OsStr::to_string_lossy`] gives it, and the details
    /// `{ variable: "DORIC_SQLITE_CACHE" }`.
    pub fn from_setting(value: Option<&OsStr>) -> Result<Self, ContractError> {
        match value {
            None => Ok(Self::default()),
            Some(value) if value.is_empty() || value == "1" => Ok(Self::default()),
            Some(value) if value == "0" => Ok(Self::new(0)),
            Some(value) => Err(refusal(
                "invalid_input",
                format!(
                    "{CACHE_VARIABLE} is \"0\" or \"1\"; \"{}\" is not.",
                    value.to_string_lossy()
                ),
                "variable",
                CACHE_VARIABLE.into(),
            )),
        }
    }

    /// The entries, locked.
    fn lock(&self) -> MutexGuard<'_, Lru> {
        self.entries.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// The most bytes the cache holds.
    pub fn bound(&self) -> usize {
        self.bound
    }

    /// The bytes the cached entries count, at most [`Headers::bound`].
    pub fn bytes(&self) -> usize {
        self.lock().bytes
    }

    /// The number of cached entries.
    pub fn len(&self) -> usize {
        self.lock().entries.len()
    }

    /// Whether the cache holds no entry.
    pub fn is_empty(&self) -> bool {
        self.lock().entries.is_empty()
    }

    /// Suspends the cache while a write it does not see runs, such as a
    /// `storage.kv/v1` commit outside `doric/`: until the answer is dropped,
    /// every [`Headers::begin`] clears the cache first, so no write
    /// transaction reads a header cached before or during the suspension;
    /// dropping it ends this suspension and clears the cache once more, so a
    /// header cached by a storage write that ran during it is not read after
    /// it. Suspensions nest: the cache is used again once every one has been
    /// dropped. One that is `mem::forget`-ed never ends, which leaves the
    /// cache off, every transaction reading SQLite, for the life of the
    /// process. Clones of a [`Headers`] share their suspensions.
    pub fn suspend(&self) -> Suspension {
        self.lock().suspended += 1;
        Suspension {
            headers: self.clone(),
        }
    }

    /// Opens the overlay of the write transaction `txn`. When
    /// [`WriteTxn::foreign_write`] answers true, another connection or
    /// process committed since this writer's last commit, and while a
    /// [`Suspension`] is alive ([`Headers::suspend`]) the platform may have
    /// written outside `doric/`; in both cases the cache is cleared first and
    /// nothing cached before it is read again. Every
    /// [`KvEngine::write`](doric_sqlite::KvEngine::write) of this library,
    /// whether it touches document headers or not, calls it first: the
    /// writer stores `data_version` after every write, so a write that skips
    /// it would hide another process's commit from the next one. A write
    /// reads and writes headers only through the answer, except `Register`'s
    /// backfill, which reads full headers through `stored_header`, writes
    /// with `txn.put` and forgets each rewritten header; test fixtures that
    /// plant raw headers are exempt.
    pub fn begin(&self, txn: &dyn WriteTxn) -> Staged {
        if txn.foreign_write() || self.lock().suspended > 0 {
            self.lock().clear();
        }
        Staged {
            headers: self.clone(),
            staged: BTreeMap::new(),
            clean: BTreeMap::new(),
        }
    }
}

/// A suspension of a [`Headers`] ([`Headers::suspend`]): while it is alive,
/// every write transaction starts on an empty cache. Dropping it ends the
/// suspension and clears the cache.
#[derive(Debug)]
#[must_use = "the suspension ends when it is dropped"]
pub struct Suspension {
    /// The cache it suspends.
    headers: Headers,
}

impl Drop for Suspension {
    /// Ends the suspension and clears the cache.
    fn drop(&mut self) {
        let mut lru = self.headers.lock();
        lru.suspended -= 1;
        lru.clear();
    }
}

/// The overlay of one write transaction on a [`Headers`]: the headers it
/// puts or forgets, and the ones it read from SQLite, which stay its own
/// until [`Staged::finish`] queues them for after `COMMIT`. Dropping it
/// without `finish`, as an error path does, leaves the cache as it was.
#[derive(Debug)]
pub struct Staged {
    headers: Headers,
    staged: BTreeMap<Vec<u8>, Option<Header>>,
    clean: BTreeMap<Vec<u8>, Header>,
}

impl Staged {
    /// The header of the document key `key`, as this transaction sees it:
    /// the header it put, else, for a key it did not forget, the cached
    /// entry, else the stored header read from `txn`; `None` for an absent
    /// document. A header read from `txn` for a key the transaction neither
    /// put nor forgot is kept as a clean read; an absent document is never
    /// kept. A write transaction passes itself, as `&mut dyn WriteTxn`
    /// coerces to `&mut dyn ReadTxn`.
    ///
    /// # Errors
    ///
    /// `internal`, the message `A stored document header does not decode:
    /// <error>.`, for a stored header that does not decode; the errors of
    /// [`ReadTxn::get`]. The overlay is unchanged.
    pub fn header(
        &mut self,
        txn: &mut dyn ReadTxn,
        key: &[u8],
    ) -> Result<Option<Header>, ContractError> {
        let forgotten = match self.staged.get(key) {
            Some(Some(header)) => return Ok(Some(header.clone())),
            Some(None) => true,
            None => false,
        };
        if !forgotten {
            if let Some(header) = self.clean.get(key) {
                return Ok(Some(header.clone()));
            }
            if let Some(header) = self.headers.lock().get(key) {
                return Ok(Some(header));
            }
        }
        let Some((value, _)) = txn.get(key)? else {
            return Ok(None);
        };
        let header = Header::from(decode_header(&value)?);
        if !forgotten {
            self.clean.insert(key.to_vec(), header.clone());
        }
        Ok(Some(header))
    }

    /// Stages `header` as the header of `key`, which the transaction has
    /// written; later reads of `key` in this transaction answer it.
    pub fn put(&mut self, key: Vec<u8>, header: Header) {
        self.clean.remove(&key);
        self.staged.insert(key, Some(header));
    }

    /// Stages that `key` leaves the cache, for a header the transaction
    /// deleted or that a rebuild rewrote, replacing a header it put; later
    /// reads of `key` in this transaction read `txn`, so a deleted document
    /// answers `None` and a rewritten one its rewritten header.
    pub fn forget(&mut self, key: Vec<u8>) {
        self.clean.remove(&key);
        self.staged.insert(key, None);
    }

    /// Queues on [`WriteTxn::on_commit`] the application of the staged puts,
    /// the staged removals and the clean reads to the cache, under its bound,
    /// so it runs after `COMMIT` succeeds and before the next write; if the
    /// transaction rolls back, nothing is applied.
    pub fn finish(self, txn: &mut dyn WriteTxn) {
        let Self {
            headers,
            staged,
            clean,
        } = self;
        txn.on_commit(Box::new(move || {
            let mut lru = headers.lock();
            for (key, header) in staged {
                match header {
                    Some(header) => lru.insert(headers.bound, key, header),
                    None => lru.remove(&key),
                }
            }
            for (key, header) in clean {
                lru.insert(headers.bound, key, header);
            }
        }));
    }
}

#[cfg(test)]
mod tests;
