//! The one writer: a dedicated thread that owns the writer connection and runs
//! one commit at a time, in the order they arrive, so positions are
//! consecutive (guarantee 2 allows it).

use std::{ops::ControlFlow, sync::Mutex, thread::JoinHandle};

use doric_bundle::{ContractError, Level};
use rusqlite::{Connection, OptionalExtension, Transaction, TransactionBehavior, params};
use tokio::sync::{mpsc, oneshot};

use crate::{
    Entry, KeyRange, ReadTxn, WriteTxn,
    access::hex,
    limits::Item,
    refusal,
    store::{closed, failure},
};

/// How many commits wait for the writer thread before a caller waits to
/// enqueue its own.
pub(crate) const QUEUE: usize = 64;

/// The highest position plus one: a position must stay below 2^53, the
/// integers a `double` holds exactly (guarantee 2).
pub(crate) const POSITION_END: i64 = 1 << 53;

/// What the writer thread receives.
enum Job {
    /// Runs one commit and answers its position or its error.
    Commit(Vec<Item>, oneshot::Sender<Result<f64, ContractError>>),
    /// Runs one write transaction of [`Writer::write`] and answers it.
    Write(Work),
    /// Checkpoints, closes the connection and ends the thread, then answers.
    Close(oneshot::Sender<()>),
}

/// One write of [`Writer::write`], run and answered on the writer thread.
type Work = Box<dyn FnOnce(&mut Connection, &mut State) + Send>;

/// What the writer thread keeps between jobs.
struct State {
    /// `PRAGMA data_version` at the thread's last [`Writer::write`] commit, or
    /// at its start; a `storage.kv/v1` commit leaves it as it is.
    data_version: i64,
}

/// The handle of the writer thread; shared by every `Commit` call.
pub(crate) struct Writer {
    /// The bounded queue of [`QUEUE`] jobs to the thread.
    jobs: mpsc::Sender<Job>,
    /// The thread, until [`Writer::close`] joins it.
    thread: Mutex<Option<JoinHandle<()>>>,
}

impl Writer {
    /// Starts the writer thread, which owns `connection`, opened and set up by
    /// [`crate::store::open`].
    ///
    /// # Errors
    ///
    /// The SQLite error of reading `PRAGMA data_version`, as [`failure`].
    pub(crate) fn new(connection: Connection) -> Result<Self, ContractError> {
        let state = State {
            data_version: data_version(&connection).map_err(failure)?,
        };
        let (jobs, queue) = mpsc::channel(QUEUE);
        let thread = std::thread::spawn(move || serve(connection, state, queue));

        Ok(Self {
            jobs,
            thread: Mutex::new(Some(thread)),
        })
    }

    /// Commits `items`, all or none, and answers the commit's position, which
    /// is also the version of every key it writes.
    ///
    /// The thread runs, on its connection:
    ///
    /// 1. `BEGIN IMMEDIATE`;
    /// 2. each condition in item order, `SELECT version FROM kv WHERE key = ?`
    ///    (no row is version 0), against the state before this commit, since
    ///    conditions are read before any mutation;
    /// 3. `position = (SELECT position FROM kv_position) + 1`;
    /// 4. the mutations in item order, each with `version = position`: a put
    ///    `INSERT INTO kv (key, value, version) VALUES (?, ?, ?) ON CONFLICT
    ///    (key) DO UPDATE SET value = excluded.value, version =
    ///    excluded.version`; a delete `DELETE FROM kv WHERE key = ?`; a clear
    ///    range `DELETE FROM kv WHERE key >= ? AND key < ?`; a positioned put
    ///    the same upsert under `key_prefix ‖ position` as a `u64`, 8 bytes,
    ///    big-endian; so a later item on the same key wins;
    /// 5. `UPDATE kv_position SET position = ?` and `COMMIT`.
    ///
    /// `items` comes from [`crate::limits::Batch::finish`], so it is checked
    /// and holds a mutation. A commit that answered `Ok` is durable
    /// (`synchronous = FULL`). Dropping the future does not stop a commit the
    /// thread has taken.
    ///
    /// # Errors
    ///
    /// Every error leaves the store as it was, after a `ROLLBACK`:
    ///
    /// - `condition_failed` with `details.key`, in lowercase hexadecimal, the
    ///   first failing condition's key in item order;
    /// - `unavailable` when the database is busy or locked past the busy
    ///   timeout (`SQLITE_BUSY`, `SQLITE_LOCKED`), or after [`Writer::close`];
    /// - `internal` when the next position would be at or above
    ///   [`POSITION_END`], or on any other SQLite error.
    pub(crate) async fn commit(&self, items: Vec<Item>) -> Result<f64, ContractError> {
        let (answer, answered) = oneshot::channel();
        self.jobs
            .send(Job::Commit(items, answer))
            .await
            .map_err(|_| closed())?;
        answered.await.map_err(|_| closed())?
    }

    /// Runs `work` in one `BEGIN IMMEDIATE … COMMIT` on the writer thread,
    /// after the jobs queued before it, at position `kv_position` + 1. When
    /// `work` answers `Ok`, the thread stores the position, commits, runs the
    /// `on_commit` callbacks in order, then answers `work`'s value and the
    /// position. Dropping the future does not stop a write the thread has
    /// taken.
    ///
    /// # Errors
    ///
    /// After a `ROLLBACK`, which drops the callbacks: the `Err` of `work`;
    /// `unavailable` after [`Writer::close`] or when the database is busy or
    /// locked past the busy timeout; `internal` when the position would be at
    /// or above [`POSITION_END`], or on any other SQLite error.
    pub(crate) async fn write<T, F>(&self, work: F) -> Result<(T, f64), ContractError>
    where
        T: Send + 'static,
        F: FnOnce(&mut dyn WriteTxn) -> Result<T, ContractError> + Send + 'static,
    {
        let (answer, answered) = oneshot::channel();
        let job = move |connection: &mut Connection, state: &mut State| {
            // A caller that went away before the thread took its write wants
            // nothing written.
            if !answer.is_closed() {
                let _ = answer.send(transact(connection, state, work));
            }
        };
        self.jobs
            .send(Job::Write(Box::new(job)))
            .await
            .map_err(|_| closed())?;
        answered.await.map_err(|_| closed())?
    }

    /// Stops the writer for good, after the commits already queued: runs
    /// `PRAGMA wal_checkpoint(TRUNCATE)`, closes the connection and joins the
    /// thread. A checkpoint that fails is logged at `warn`; the connection
    /// still closes. A commit after it answers `unavailable`; calling it again
    /// does nothing.
    pub(crate) async fn close(&self) {
        let (done, ended) = oneshot::channel();
        if self.jobs.send(Job::Close(done)).await.is_ok() {
            let _ = ended.await;
        }
        let thread = self.thread.lock().ok().and_then(|mut thread| thread.take());
        if let Some(thread) = thread
            && !matches!(
                tokio::task::spawn_blocking(move || thread.join()).await,
                Ok(Ok(()))
            )
        {
            doric_bundle::log(Level::Warn, "The writer thread did not end cleanly.");
        }
    }
}

/// The writer thread: runs each job in arrival order until `Close`, or until
/// every [`Writer`] handle is gone.
fn serve(mut connection: Connection, mut state: State, mut queue: mpsc::Receiver<Job>) {
    while let Some(job) = queue.blocking_recv() {
        match job {
            // A caller that went away before the thread took its commit
            // wants nothing written.
            Job::Commit(_, answer) if answer.is_closed() => {}
            Job::Commit(items, answer) => {
                let _ = answer.send(run(&mut connection, &items));
            }
            Job::Write(write) => write(&mut connection, &mut state),
            Job::Close(done) => {
                shut(connection);
                let _ = done.send(());
                return;
            }
        }
    }
    shut(connection);
}

/// Runs one commit in one `BEGIN IMMEDIATE` transaction; dropping the
/// transaction on an error rolls it back.
fn run(connection: &mut Connection, items: &[Item]) -> Result<f64, ContractError> {
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(failure)?;

    for item in items {
        if let Item::Condition { key, version } = item
            && version_of(&transaction, key).map_err(failure)? as f64 != *version
        {
            let key = hex(key);
            return Err(refusal(
                "condition_failed",
                format!("The condition on the key {key} failed."),
                "key",
                key.into(),
            ));
        }
    }
    let position = next_position(&transaction)?;
    items
        .iter()
        .try_for_each(|item| apply(&transaction, item, position))
        .and_then(|()| {
            transaction.execute("UPDATE kv_position SET position = ?", [position])?;
            transaction.commit()
        })
        .map_err(failure)?;

    Ok(position as f64)
}

/// Runs one write of [`Writer::write`] in one `BEGIN IMMEDIATE` transaction,
/// then its callbacks; dropping the transaction on an error rolls it back and
/// drops them.
fn transact<T>(
    connection: &mut Connection,
    state: &mut State,
    work: impl FnOnce(&mut dyn WriteTxn) -> Result<T, ContractError>,
) -> Result<(T, f64), ContractError> {
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(failure)?;
    let current = data_version(&transaction).map_err(failure)?;
    let position = next_position(&transaction)?;
    let mut txn = Txn {
        transaction,
        position,
        foreign: current != state.data_version,
        callbacks: Vec::new(),
    };

    let value = work(&mut txn)?;
    let Txn {
        transaction,
        callbacks,
        ..
    } = txn;
    transaction
        .execute("UPDATE kv_position SET position = ?", [position])
        .and_then(|_| transaction.commit())
        .map_err(failure)?;
    state.data_version = current;
    callbacks.into_iter().for_each(|then| then());

    Ok((value, position as f64))
}

/// The position of the transaction `transaction`: the stored one plus one.
///
/// # Errors
///
/// `internal` when it would be at or above [`POSITION_END`]; [`failure`] on a
/// SQLite error.
fn next_position(transaction: &Transaction<'_>) -> Result<i64, ContractError> {
    let position = transaction
        .query_row("SELECT position FROM kv_position", [], |row| {
            row.get::<_, i64>(0)
        })
        .map_err(failure)?
        + 1;
    if position >= POSITION_END {
        return Err(ContractError::new(
            "internal",
            "The store has no position left.",
        ));
    }
    Ok(position)
}

/// `PRAGMA data_version` of `connection`, which changes when another
/// connection commits.
fn data_version(connection: &Connection) -> rusqlite::Result<i64> {
    connection.pragma_query_value(None, "data_version", |row| row.get(0))
}

/// One write transaction of [`Writer::write`] at `position`.
struct Txn<'c> {
    transaction: Transaction<'c>,
    position: i64,
    /// Whether `data_version` changed since the writer's last commit.
    foreign: bool,
    /// The `on_commit` callbacks, in the order queued.
    callbacks: Vec<Box<dyn FnOnce() + Send>>,
}

impl ReadTxn for Txn<'_> {
    fn get(&mut self, key: &[u8]) -> Result<Option<(Vec<u8>, f64)>, ContractError> {
        self.transaction.get(key)
    }

    fn range(
        &mut self,
        range: &KeyRange,
        each: &mut dyn FnMut(Entry<'_>) -> ControlFlow<()>,
    ) -> Result<(), ContractError> {
        self.transaction.range(range, each)
    }
}

impl WriteTxn for Txn<'_> {
    fn position(&self) -> f64 {
        self.position as f64
    }

    fn put(&mut self, key: &[u8], value: &[u8]) -> Result<(), ContractError> {
        upsert(&self.transaction, key, value, self.position)
            .map(|_| ())
            .map_err(failure)
    }

    fn delete(&mut self, key: &[u8]) -> Result<(), ContractError> {
        apply(
            &self.transaction,
            &Item::Delete(key.to_vec()),
            self.position,
        )
        .map_err(failure)
    }

    fn clear_range(&mut self, start: &[u8], end: &[u8]) -> Result<(), ContractError> {
        let item = Item::ClearRange {
            start: start.to_vec(),
            end: end.to_vec(),
        };
        apply(&self.transaction, &item, self.position).map_err(failure)
    }

    fn foreign_write(&self) -> bool {
        self.foreign
    }

    fn on_commit(&mut self, then: Box<dyn FnOnce() + Send>) {
        self.callbacks.push(then);
    }
}

/// The version of `key`; 0 when it is absent.
fn version_of(transaction: &Transaction<'_>, key: &[u8]) -> rusqlite::Result<i64> {
    transaction
        .prepare_cached("SELECT version FROM kv WHERE key = ?")?
        .query_row([key], |row| row.get(0))
        .optional()
        .map(Option::unwrap_or_default)
}

/// Applies one mutation at `position`; a condition was checked before.
fn apply(transaction: &Transaction<'_>, item: &Item, position: i64) -> rusqlite::Result<()> {
    let put = |key: &[u8], value: &[u8]| upsert(transaction, key, value, position);

    match item {
        Item::Condition { .. } => Ok(0),
        Item::Put { key, value } => put(key, value),
        Item::Delete(key) => transaction
            .prepare_cached("DELETE FROM kv WHERE key = ?")?
            .execute([key]),
        Item::ClearRange { start, end } => transaction
            .prepare_cached("DELETE FROM kv WHERE key >= ? AND key < ?")?
            .execute([start, end]),
        Item::PositionedPut { key_prefix, value } => {
            put(&[key_prefix, &position.to_be_bytes()[..]].concat(), value)
        }
    }
    .map(|_| ())
}

/// Writes `value` under `key` at version `position`.
fn upsert(
    transaction: &Transaction<'_>,
    key: &[u8],
    value: &[u8],
    position: i64,
) -> rusqlite::Result<usize> {
    transaction
        .prepare_cached(
            "INSERT INTO kv (key, value, version) VALUES (?, ?, ?) \
             ON CONFLICT (key) DO UPDATE SET value = excluded.value, \
             version = excluded.version",
        )?
        .execute(params![key, value, position])
}

/// Checkpoints the WAL and closes the connection; a failure is logged.
fn shut(connection: Connection) {
    let checkpoint = connection.query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |row| {
        row.get::<_, i64>(0)
    });
    match checkpoint {
        Ok(0) => {}
        Ok(_) => doric_bundle::log(Level::Warn, "The WAL checkpoint was blocked."),
        Err(error) => {
            doric_bundle::log(Level::Warn, &format!("The WAL checkpoint failed: {error}."))
        }
    }
    if let Err((_, error)) = connection.close() {
        doric_bundle::log(
            Level::Warn,
            &format!("The writer connection did not close: {error}."),
        );
    }
}

#[cfg(test)]
mod tests;
