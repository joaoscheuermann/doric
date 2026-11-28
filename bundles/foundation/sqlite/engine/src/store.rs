//! The file `doric.sqlite3` and its connections: one writer ([`Writer`]) and
//! four readers ([`Readers`]).

use std::{path::Path, time::Duration};

use doric_bundle::ContractError;
use rusqlite::{Connection, ErrorCode, OpenFlags};
use tokio_stream::wrappers::ReceiverStream;

use crate::{
    KvEngine, ReadTxn, WriteTxn,
    kv::{GetResponse, RangeRequest, RangeResponse},
    limits::Item,
    readers::Readers,
    refusal,
    writer::Writer,
};

/// The name of the store's file in its directory, beside its `-wal` and
/// `-shm` files.
pub(crate) const FILE: &str = "doric.sqlite3";

/// The file format this engine writes and reads (`PRAGMA user_version`); a new
/// file has 0 until its first open.
pub(crate) const FORMAT: i64 = 1;

/// The number of reader connections.
pub(crate) const READERS: usize = 4;

/// How long a connection waits for a lock another connection or process holds
/// (`PRAGMA busy_timeout`), in milliseconds.
pub(crate) const BUSY_TIMEOUT_MS: u32 = 5000;

/// An open store: every commit goes to `writer`, every read to `readers`.
pub struct SqliteEngine {
    pub(crate) writer: Writer,
    pub(crate) readers: Readers,
}

/// Opens the store `dir/doric.sqlite3`, creating the file when it is absent.
/// It blocks, so an async caller runs it on `tokio::task::spawn_blocking`.
///
/// In this order:
///
/// 1. `dir` must exist and be a directory; the engine never creates it.
/// 2. The writer connection opens the file read-write, creating it, and reads
///    `PRAGMA user_version` before it changes anything.
/// 3. A `user_version` other than 0 or [`FORMAT`] stops the open, and the file
///    is left as it was.
/// 4. The writer runs `PRAGMA journal_mode = WAL`, which must answer `wal`;
///    then `synchronous = FULL`, `busy_timeout = 5000`, `foreign_keys = OFF`;
///    then `CREATE TABLE IF NOT EXISTS kv (key BLOB NOT NULL PRIMARY KEY,
///    value BLOB NOT NULL, version INTEGER NOT NULL) WITHOUT ROWID`, `CREATE
///    TABLE IF NOT EXISTS kv_position (id INTEGER NOT NULL PRIMARY KEY CHECK
///    (id = 1), position INTEGER NOT NULL)`, `INSERT OR IGNORE INTO
///    kv_position (id, position) VALUES (1, 0)` and `PRAGMA user_version = 1`.
///    Each step is idempotent, so reopening a file of format 1 changes no row.
/// 5. [`READERS`] reader connections open the file with
///    `SQLITE_OPEN_READ_ONLY | SQLITE_OPEN_NO_MUTEX` and `busy_timeout =
///    5000`.
/// 6. The writer connection moves to its thread ([`Writer::new`]) and the
///    readers behind their semaphore ([`Readers::new`]).
///
/// # Errors
///
/// - `storage_path_missing` with `details.path`, `dir` as given, when `dir`
///   does not exist or is not a directory; nothing is created.
/// - `storage_format_unsupported` with `details.userVersion`, the number read,
///   for a `user_version` other than 0 or 1; the file is untouched.
/// - `internal` when `journal_mode` answers anything but `wal`, or on any
///   other SQLite error. Every connection opened so far is closed.
pub fn open(dir: &Path) -> Result<SqliteEngine, ContractError> {
    if !dir.is_dir() {
        let path = dir.to_string_lossy();
        return Err(refusal(
            "storage_path_missing",
            format!("The storage path {path} is not a directory."),
            "path",
            path.as_ref().into(),
        ));
    }
    let file = dir.join(FILE);
    let writer = Connection::open_with_flags(
        &file,
        OpenFlags::SQLITE_OPEN_READ_WRITE
            | OpenFlags::SQLITE_OPEN_CREATE
            | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(failure)?;

    let version: i64 = writer
        .pragma_query_value(None, "user_version", |row| row.get(0))
        .map_err(failure)?;
    if version != 0 && version != FORMAT {
        return Err(refusal(
            "storage_format_unsupported",
            format!("The store's format {version} is not {FORMAT}."),
            "userVersion",
            (version as f64).into(),
        ));
    }
    set_up(&writer)?;

    let readers = (0..READERS)
        .map(|_| reader(&file))
        .collect::<Result<_, _>>()?;
    Ok(SqliteEngine {
        writer: Writer::new(writer)?,
        readers: Readers::new(readers),
    })
}

/// Sets up the writer connection: WAL, the pragmas, the tables and the
/// format. Each step is idempotent.
fn set_up(writer: &Connection) -> Result<(), ContractError> {
    let mode: String = writer
        .pragma_update_and_check(None, "journal_mode", "WAL", |row| row.get(0))
        .map_err(failure)?;
    if !mode.eq_ignore_ascii_case("wal") {
        return Err(ContractError::new(
            "internal",
            format!("The journal mode is {mode}, not wal."),
        ));
    }
    writer
        .busy_timeout(BUSY_TIMEOUT)
        .and_then(|()| {
            writer.execute_batch(&format!(
                "PRAGMA synchronous = FULL;
                 PRAGMA foreign_keys = OFF;
                 CREATE TABLE IF NOT EXISTS kv (key BLOB NOT NULL PRIMARY KEY, \
                 value BLOB NOT NULL, version INTEGER NOT NULL) WITHOUT ROWID;
                 CREATE TABLE IF NOT EXISTS kv_position (id INTEGER NOT NULL PRIMARY KEY \
                 CHECK (id = 1), position INTEGER NOT NULL);
                 INSERT OR IGNORE INTO kv_position (id, position) VALUES (1, 0);
                 PRAGMA user_version = {FORMAT};"
            ))
        })
        .map_err(failure)
}

/// Opens one reader connection on `file`.
fn reader(file: &Path) -> Result<Connection, ContractError> {
    let connection = Connection::open_with_flags(
        file,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(failure)?;
    connection.busy_timeout(BUSY_TIMEOUT).map_err(failure)?;
    Ok(connection)
}

/// [`BUSY_TIMEOUT_MS`] as a duration.
const BUSY_TIMEOUT: Duration = Duration::from_millis(BUSY_TIMEOUT_MS as u64);

/// The answer to a SQLite error: `unavailable` when the database is busy or
/// locked past the busy timeout, `internal` otherwise.
pub(crate) fn failure(error: rusqlite::Error) -> ContractError {
    match error.sqlite_error_code() {
        Some(ErrorCode::DatabaseBusy | ErrorCode::DatabaseLocked) => {
            ContractError::new("unavailable", format!("The store is busy: {error}."))
        }
        _ => ContractError::new("internal", format!("SQLite failed: {error}.")),
    }
}

/// The answer to a call on a closed store.
pub(crate) fn closed() -> ContractError {
    ContractError::new("unavailable", "The store is closed.")
}

impl SqliteEngine {
    /// Reads `keys`, already checked by [`crate::limits::get`], and answers one
    /// item per key, in the order given, all from one committed state; an
    /// absent key answers no `value` and version 0. It does not block.
    ///
    /// # Errors
    ///
    /// The stream's last item is the error: `unavailable` after
    /// [`SqliteEngine::close`] or when the database is busy or locked past the
    /// busy timeout; `internal` on any other SQLite error. Items sent before it
    /// stand.
    pub fn get(&self, keys: Vec<Vec<u8>>) -> ReceiverStream<Result<GetResponse, ContractError>> {
        self.readers.get(keys)
    }

    /// Reads the range `request`, already checked by [`crate::limits::range`]:
    /// its entries in key order, or reverse order, at most `limit`, all from
    /// one committed state, an empty `value` for `keys_only`. It does not
    /// block, and a dropped stream ends the read.
    ///
    /// # Errors
    ///
    /// As for [`SqliteEngine::get`].
    pub fn range(
        &self,
        request: RangeRequest,
    ) -> ReceiverStream<Result<RangeResponse, ContractError>> {
        self.readers.range(request)
    }

    /// Commits `items`, from [`crate::limits::Batch::finish`], all or none,
    /// and answers the commit's position, one more than the last. A commit
    /// that answered `Ok` is durable; dropping the future does not stop a
    /// commit the writer has taken.
    ///
    /// # Errors
    ///
    /// Every error leaves the store as it was: `condition_failed` with
    /// `details.key`, the first failing condition's key in lowercase
    /// hexadecimal; `unavailable` after [`SqliteEngine::close`] or when the
    /// database is busy or locked past the busy timeout; `internal` when the
    /// next position would reach 2^53, or on any other SQLite error.
    pub async fn commit(&self, items: Vec<Item>) -> Result<f64, ContractError> {
        self.writer.commit(items).await
    }

    /// Closes the store for good: first the writer ([`Writer::close`]), which
    /// waits for the commit in progress and checkpoints the WAL, then the
    /// readers ([`Readers::close`]). A commit or read after it answers
    /// `unavailable`. Calling it again does nothing.
    pub async fn close(&self) {
        self.writer.close().await;
        self.readers.close().await;
    }
}

impl KvEngine for SqliteEngine {
    fn read<T, F>(&self, work: F) -> impl Future<Output = Result<T, ContractError>> + Send
    where
        T: Send + 'static,
        F: FnOnce(&mut dyn ReadTxn) -> Result<T, ContractError> + Send + 'static,
    {
        self.readers.run(work)
    }

    fn write<T, F>(&self, work: F) -> impl Future<Output = Result<(T, f64), ContractError>> + Send
    where
        T: Send + 'static,
        F: FnOnce(&mut dyn WriteTxn) -> Result<T, ContractError> + Send + 'static,
    {
        self.writer.write(work)
    }

    async fn close(&self) {
        SqliteEngine::close(self).await;
    }
}

/// What the tests of every module share: a temporary directory, an open store
/// in one, and the fields of an error's details.
#[cfg(test)]
pub(crate) mod testing {
    use std::{
        path::{Path, PathBuf},
        sync::atomic::{AtomicUsize, Ordering},
    };

    use doric_bundle::ContractError;
    use prost_types::value::Kind;
    use tokio_stream::{StreamExt, wrappers::ReceiverStream};

    use super::{SqliteEngine, open};

    /// A directory under `std::env::temp_dir()`, unique by pid and counter,
    /// removed with everything in it when dropped.
    pub(crate) struct TempDir {
        path: PathBuf,
    }

    impl TempDir {
        /// The path of a new unique directory, which is not created.
        pub(crate) fn missing() -> Self {
            static COUNTER: AtomicUsize = AtomicUsize::new(0);
            let count = COUNTER.fetch_add(1, Ordering::Relaxed);
            let name = format!("doric-sqlite-{}-{count}", std::process::id());
            Self {
                path: std::env::temp_dir().join(name),
            }
        }

        /// A new, empty, unique directory.
        pub(crate) fn new() -> Self {
            let dir = Self::missing();
            std::fs::create_dir_all(&dir.path).expect("create the temporary directory");
            dir
        }

        pub(crate) fn path(&self) -> &Path {
            &self.path
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.path);
        }
    }

    /// A store opened in a new temporary directory, with the directory.
    pub(crate) fn open_temp() -> (TempDir, SqliteEngine) {
        let dir = TempDir::new();
        let store = open(dir.path()).expect("open the store");
        (dir, store)
    }

    /// The string detail `field` of `error`.
    pub(crate) fn detail_str(error: &ContractError, field: &str) -> Option<String> {
        match error.details.as_ref()?.fields.get(field)?.kind.as_ref()? {
            Kind::StringValue(value) => Some(value.clone()),
            _ => None,
        }
    }

    /// The number detail `field` of `error`.
    pub(crate) fn detail_num(error: &ContractError, field: &str) -> Option<f64> {
        match error.details.as_ref()?.fields.get(field)?.kind.as_ref()? {
            Kind::NumberValue(value) => Some(*value),
            _ => None,
        }
    }

    /// Every item of `stream`, until it ends.
    pub(crate) async fn collect<T>(stream: ReceiverStream<T>) -> Vec<T> {
        stream.collect().await
    }
}

#[cfg(test)]
mod foreign;

#[cfg(test)]
mod tests;
