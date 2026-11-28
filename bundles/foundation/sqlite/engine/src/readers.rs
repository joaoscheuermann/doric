//! The reader connections: four read-only connections, each used by one
//! blocking task at a time, so reads never wait for the writer and each read
//! transaction is a snapshot (WAL).
//!
//! The S72 rule for a Rust handler: no blocking work before its first
//! `.await`. [`Readers::get`] and [`Readers::range`] therefore only spawn and
//! return; the task they spawn waits for a connection, then runs the SQLite
//! work on `tokio::task::spawn_blocking`, which `blocking_send`s each answer
//! into a bounded channel of [`ANSWERS`]. The SDK takes an answer only when it
//! has credit, so a large range is never held in memory.

use std::{
    ops::ControlFlow,
    sync::{Arc, Mutex},
};

use doric_bundle::ContractError;
use rusqlite::{Connection, OptionalExtension, Transaction, TransactionBehavior, params};
use tokio::sync::{Semaphore, mpsc, oneshot};
use tokio_stream::wrappers::ReceiverStream;

use crate::{
    Entry, KeyRange, ReadTxn,
    kv::{GetResponse, RangeRequest, RangeResponse},
    store::{closed, failure},
};

/// How many answers wait in a call's channel before the blocking task waits.
pub(crate) const ANSWERS: usize = 16;

/// The reader connections, shared by every `Get` and `Range` call.
pub(crate) struct Readers {
    /// The idle connections; a task takes one under a permit and returns it.
    connections: Arc<Mutex<Vec<Connection>>>,
    /// One permit per connection; closed by [`Readers::close`].
    permits: Arc<Semaphore>,
    /// The number of connections, so of permits.
    count: u32,
}

/// What a blocking read sends its answers into.
type Answers<T> = mpsc::Sender<Result<T, ContractError>>;

impl Readers {
    /// Holds `connections`, opened read-only by [`crate::store::open`], behind
    /// a semaphore of as many permits.
    pub(crate) fn new(connections: Vec<Connection>) -> Self {
        let count = connections.len();

        Self {
            connections: Arc::new(Mutex::new(connections)),
            permits: Arc::new(Semaphore::new(count)),
            count: u32::try_from(count).unwrap_or(u32::MAX),
        }
    }

    /// Reads `keys`, checked by [`crate::limits::get`], and answers one item
    /// per key, in the order given, all inside one `BEGIN DEFERRED … COMMIT`,
    /// so from one committed state (guarantee 4): `SELECT value, version FROM
    /// kv WHERE key = ?`, an absent key answering no `value` and version 0.
    ///
    /// It does not block: it spawns the read and returns its stream at once.
    /// Once the stream is dropped, the call was cancelled: the next send fails,
    /// the task rolls back and returns its connection.
    ///
    /// # Errors
    ///
    /// The stream's last item is the error: `unavailable` after
    /// [`Readers::close`] or when the database is busy or locked past the busy
    /// timeout; `internal` on any other SQLite error, after a rollback. Items
    /// sent before it stand.
    pub(crate) fn get(
        &self,
        keys: Vec<Vec<u8>>,
    ) -> ReceiverStream<Result<GetResponse, ContractError>> {
        self.read(move |transaction, answers| {
            let mut select =
                transaction.prepare_cached("SELECT value, version FROM kv WHERE key = ?")?;
            for key in keys {
                let row = select
                    .query_row([&key], |row| Ok((row.get(0)?, row.get::<_, i64>(1)?)))
                    .optional()?;
                let (value, version) = row.map_or((None, 0.0), |(value, version)| {
                    (Some(value), version as f64)
                });
                if answers
                    .blocking_send(Ok(GetResponse {
                        key,
                        value,
                        version,
                    }))
                    .is_err()
                {
                    return Ok(false);
                }
            }
            Ok(true)
        })
    }

    /// Reads the range `request`, checked by [`crate::limits::range`], inside
    /// one `BEGIN DEFERRED … COMMIT` (guarantee 4): `SELECT key, value, version
    /// FROM kv WHERE key >= ? AND key < ? ORDER BY key [DESC] LIMIT ?`, without
    /// `value` for `keys_only`, which answers an empty `value`. Answers each
    /// row as it is read.
    ///
    /// It does not block, and a dropped stream ends the read, as for
    /// [`Readers::get`].
    ///
    /// # Errors
    ///
    /// As for [`Readers::get`].
    pub(crate) fn range(
        &self,
        request: RangeRequest,
    ) -> ReceiverStream<Result<RangeResponse, ContractError>> {
        self.read(move |transaction, answers| {
            let RangeRequest {
                start,
                end,
                limit,
                reverse,
                keys_only,
            } = request;
            let sql = format!(
                "SELECT key, version{} FROM kv WHERE key >= ? AND key < ? ORDER BY key {} LIMIT ?",
                if keys_only { "" } else { ", value" },
                if reverse { "DESC" } else { "ASC" },
            );
            let mut select = transaction.prepare_cached(&sql)?;
            let mut rows = select.query(params![start, end, limit])?;
            while let Some(row) = rows.next()? {
                let entry = RangeResponse {
                    key: row.get(0)?,
                    version: row.get::<_, i64>(1)? as f64,
                    value: if keys_only { Vec::new() } else { row.get(2)? },
                };
                if answers.blocking_send(Ok(entry)).is_err() {
                    return Ok(false);
                }
            }
            Ok(true)
        })
    }

    /// Spawns `work` on an idle connection, inside one `BEGIN DEFERRED …
    /// COMMIT`, and returns the stream of its answers at once. `work` answers
    /// `false` when the stream is gone, and the transaction rolls back.
    fn read<T, F>(&self, work: F) -> ReceiverStream<Result<T, ContractError>>
    where
        T: Send + 'static,
        F: FnOnce(&Transaction<'_>, &Answers<T>) -> rusqlite::Result<bool> + Send + 'static,
    {
        let (answers, stream) = mpsc::channel(ANSWERS);
        let connections = Arc::clone(&self.connections);
        let permits = Arc::clone(&self.permits);

        tokio::spawn(async move {
            let Ok(permit) = permits.acquire_owned().await else {
                let _ = answers.send(Err(closed())).await;
                return;
            };
            let _ = tokio::task::spawn_blocking(move || {
                let _permit = permit;
                let Some(mut connection) = connections.lock().ok().and_then(|mut idle| idle.pop())
                else {
                    let _ = answers.blocking_send(Err(closed()));
                    return;
                };
                if let Err(error) = run(&mut connection, &answers, work) {
                    let _ = answers.blocking_send(Err(failure(error)));
                }
                if let Ok(mut idle) = connections.lock() {
                    idle.push(connection);
                }
            })
            .await;
        });
        ReceiverStream::new(stream)
    }

    /// Runs `work` in one `BEGIN DEFERRED … COMMIT` on an idle connection,
    /// waiting for one, and answers its value. The SQLite work runs on
    /// `tokio::task::spawn_blocking`; an `Err` of `work` rolls back.
    ///
    /// # Errors
    ///
    /// The `Err` of `work`; `unavailable` after [`Readers::close`] or when the
    /// database is busy or locked past the busy timeout; `internal` on any
    /// other SQLite error.
    pub(crate) async fn run<T, F>(&self, work: F) -> Result<T, ContractError>
    where
        T: Send + 'static,
        F: FnOnce(&mut dyn ReadTxn) -> Result<T, ContractError> + Send + 'static,
    {
        let permit = Arc::clone(&self.permits)
            .acquire_owned()
            .await
            .map_err(|_| closed())?;
        let connections = Arc::clone(&self.connections);
        let (answer, answered) = oneshot::channel();

        tokio::task::spawn_blocking(move || {
            let _permit = permit;
            let Some(mut connection) = connections.lock().ok().and_then(|mut idle| idle.pop())
            else {
                let _ = answer.send(Err(closed()));
                return;
            };
            let _ = answer.send(snapshot(&mut connection, work));
            if let Ok(mut idle) = connections.lock() {
                idle.push(connection);
            }
        });
        answered.await.map_err(|_| closed())?
    }

    /// Closes the readers for good: waits for every read in progress, then
    /// closes every connection. A read after it answers `unavailable`; calling
    /// it again does nothing.
    pub(crate) async fn close(&self) {
        if let Ok(all) = self.permits.acquire_many(self.count).await {
            self.permits.close();
            drop(all);
            if let Ok(mut idle) = self.connections.lock() {
                idle.clear();
            }
        }
    }
}

/// Runs `work` on `connection` in one deferred transaction, committed when
/// `work` answered every item and rolled back otherwise.
fn run<T, F>(connection: &mut Connection, answers: &Answers<T>, work: F) -> rusqlite::Result<()>
where
    F: FnOnce(&Transaction<'_>, &Answers<T>) -> rusqlite::Result<bool>,
{
    let transaction = connection.transaction_with_behavior(TransactionBehavior::Deferred)?;
    if work(&transaction, answers)? {
        transaction.commit()?;
    }
    Ok(())
}

/// Runs `work` on `connection` in one deferred transaction, committed when
/// `work` answers `Ok` and rolled back otherwise.
fn snapshot<T>(
    connection: &mut Connection,
    work: impl FnOnce(&mut dyn ReadTxn) -> Result<T, ContractError>,
) -> Result<T, ContractError> {
    let mut transaction = connection
        .transaction_with_behavior(TransactionBehavior::Deferred)
        .map_err(failure)?;
    let value = work(&mut transaction)?;
    transaction.commit().map_err(failure)?;
    Ok(value)
}

impl ReadTxn for Transaction<'_> {
    fn get(&mut self, key: &[u8]) -> Result<Option<(Vec<u8>, f64)>, ContractError> {
        self.prepare_cached("SELECT value, version FROM kv WHERE key = ?")
            .and_then(|mut select| {
                select
                    .query_row([key], |row| Ok((row.get(0)?, row.get::<_, i64>(1)? as f64)))
                    .optional()
            })
            .map_err(failure)
    }

    fn range(
        &mut self,
        range: &KeyRange,
        each: &mut dyn FnMut(Entry<'_>) -> ControlFlow<()>,
    ) -> Result<(), ContractError> {
        visit(self, range, each).map_err(failure)
    }
}

/// Calls `each` with every entry of `range` read on `connection`, until it
/// answers [`ControlFlow::Break`].
fn visit(
    connection: &Connection,
    range: &KeyRange,
    each: &mut dyn FnMut(Entry<'_>) -> ControlFlow<()>,
) -> rusqlite::Result<()> {
    let sql = format!(
        "SELECT key, version{} FROM kv WHERE key >= ? AND key < ? ORDER BY key {}",
        if range.keys_only { "" } else { ", value" },
        if range.reverse { "DESC" } else { "ASC" },
    );
    let mut select = connection.prepare_cached(&sql)?;
    let mut rows = select.query(params![range.start, range.end])?;
    while let Some(row) = rows.next()? {
        let entry = Entry {
            key: row.get_ref(0)?.as_blob()?,
            version: row.get::<_, i64>(1)? as f64,
            value: if range.keys_only {
                &[]
            } else {
                row.get_ref(2)?.as_blob()?
            },
        };
        if each(entry).is_break() {
            break;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests;
