#![forbid(unsafe_code)]
//! The key-value engine of the bundle `sqlite` (spec
//! `docs/designs/grpc-processes.md`, section 17, "The engine"): the one SQLite
//! file `doric.sqlite3` in a directory, opened by [`open`], with one writer
//! thread and four read-only connections. It stores keys and values and reads
//! no value.
//!
//! [`SqliteEngine`] serves `storage.kv/v1` through its inherent methods, and
//! [`KvEngine`] gives a caller its read and write transactions.

use std::ops::ControlFlow;

use doric_bundle::ContractError;

pub use access::{DORIC, hex};
pub use store::{SqliteEngine, open};

mod access;
pub mod limits;
mod readers;
mod store;
mod writer;

/// The generated messages of `doric.storage.kv.v1`.
#[allow(clippy::all)]
pub mod kv {
    include!(concat!(env!("OUT_DIR"), "/doric.storage.kv.v1.rs"));
}

/// The version of the SQLite library the engine is linked with, such as
/// `3.50.4`.
pub fn sqlite_version() -> &'static str {
    rusqlite::version()
}

/// A [`ContractError`] of `code` with `message` and one detail, `field` =
/// `value`.
pub fn refusal(
    code: &str,
    message: impl Into<String>,
    field: &str,
    value: prost_types::Value,
) -> ContractError {
    ContractError {
        details: Some(prost_types::Struct {
            fields: [(field.to_owned(), value)].into(),
        }),
        ..ContractError::new(code, message)
    }
}

/// The keys of `[start, end)`, bytewise, in key order or, with `reverse`, in
/// reverse order; with `keys_only`, without their values. A `start` at or after
/// `end` is an empty range.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct KeyRange {
    /// The first key of the range, included.
    pub start: Vec<u8>,
    /// The key after the range, excluded.
    pub end: Vec<u8>,
    /// Whether the entries come from the last key to the first.
    pub reverse: bool,
    /// Whether the entries leave `value` empty.
    pub keys_only: bool,
}

/// One entry of a range, borrowed from the transaction for the length of one
/// call of the visitor.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Entry<'a> {
    /// The entry's key.
    pub key: &'a [u8],
    /// The entry's value; empty with [`KeyRange::keys_only`].
    pub value: &'a [u8],
    /// The position of the commit that last wrote the key, at least 1.
    pub version: f64,
}

/// Transactions on the key-value store. Every read is a snapshot and every
/// write is all or none; writes run one at a time, so their positions are
/// consecutive.
pub trait KvEngine: Send + Sync + 'static {
    /// Runs `work` in one read transaction (`BEGIN DEFERRED … COMMIT`) on an
    /// idle reader connection, waiting for one, and answers its value. Every
    /// read of `work` sees one committed state, a snapshot; `work` runs off the
    /// runtime's threads and writes nothing.
    ///
    /// # Errors
    ///
    /// The `Err` of `work`; `unavailable` after [`KvEngine::close`] or when the
    /// database is busy or locked past the busy timeout; `internal` on any
    /// other SQLite error.
    fn read<T, F>(&self, work: F) -> impl Future<Output = Result<T, ContractError>> + Send
    where
        T: Send + 'static,
        F: FnOnce(&mut dyn ReadTxn) -> Result<T, ContractError> + Send + 'static;

    /// Runs `work` in one write transaction (`BEGIN IMMEDIATE … COMMIT`) on the
    /// writer thread, after the writes queued before it, and answers `work`'s
    /// value and the transaction's position ([`WriteTxn::position`]). After
    /// `Ok`, the writes are durable, the stored position is that position, and
    /// the `on_commit` callbacks have been queued to run before the next write.
    ///
    /// # Errors
    ///
    /// An `Err` from `work` rolls back, drops its `on_commit` callbacks, leaves
    /// the position as it was and is answered as is. Otherwise, after a
    /// rollback: `unavailable` after [`KvEngine::close`] or when the database
    /// is busy or locked past the busy timeout; `internal` when the position
    /// would reach 2^53, or on any other SQLite error.
    fn write<T, F>(&self, work: F) -> impl Future<Output = Result<(T, f64), ContractError>> + Send
    where
        T: Send + 'static,
        F: FnOnce(&mut dyn WriteTxn) -> Result<T, ContractError> + Send + 'static;

    /// Closes the engine for good, as [`SqliteEngine::close`]: after the write
    /// in progress, it checkpoints the WAL and closes every connection. A read
    /// or write after it answers `unavailable`; calling it again does nothing.
    fn close(&self) -> impl Future<Output = ()> + Send;
}

/// The reads of one transaction, all from one committed state.
pub trait ReadTxn {
    /// The value and version of `key`, or `None` when it is absent.
    ///
    /// # Errors
    ///
    /// `unavailable` when the database is busy or locked past the busy
    /// timeout; `internal` on any other SQLite error.
    fn get(&mut self, key: &[u8]) -> Result<Option<(Vec<u8>, f64)>, ContractError>;

    /// Calls `each` with every entry of `range`, in its order, until `each`
    /// answers [`ControlFlow::Break`] or the range ends. No entry is held past
    /// its call.
    ///
    /// # Errors
    ///
    /// As for [`ReadTxn::get`]; entries already passed to `each` stand.
    fn range(
        &mut self,
        range: &KeyRange,
        each: &mut dyn FnMut(Entry<'_>) -> ControlFlow<()>,
    ) -> Result<(), ContractError>;
}

/// The reads and writes of one write transaction. Its reads see its own
/// writes; nothing it writes is visible outside it before `COMMIT`.
pub trait WriteTxn: ReadTxn {
    /// The transaction's position, `kv_position` + 1: the version of every key
    /// it writes. The same for the whole transaction.
    fn position(&self) -> f64;

    /// Writes `value` under `key`, at version [`WriteTxn::position`].
    ///
    /// # Errors
    ///
    /// As for [`ReadTxn::get`].
    fn put(&mut self, key: &[u8], value: &[u8]) -> Result<(), ContractError>;

    /// Removes `key`; an absent key is no error.
    ///
    /// # Errors
    ///
    /// As for [`ReadTxn::get`].
    fn delete(&mut self, key: &[u8]) -> Result<(), ContractError>;

    /// Removes every key of `[start, end)`, bytewise; a `start` at or after
    /// `end` removes nothing.
    ///
    /// # Errors
    ///
    /// As for [`ReadTxn::get`].
    fn clear_range(&mut self, start: &[u8], end: &[u8]) -> Result<(), ContractError>;

    /// Whether another connection or process committed since this writer's last
    /// `KvEngine::write` commit; a `storage.kv/v1` commit on the writer changes
    /// neither the answer nor what it compares against.
    fn foreign_write(&self) -> bool;

    /// Queues `then` to run on the writer thread once the transaction has
    /// committed, before the next write begins; it never runs if the
    /// transaction rolls back.
    fn on_commit(&mut self, then: Box<dyn FnOnce() + Send>);
}
