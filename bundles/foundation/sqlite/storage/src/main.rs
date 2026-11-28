#![forbid(unsafe_code)]
//! The engine bundle `sqlite` (spec `docs/designs/grpc-processes.md`, section
//! 17, "The engine"): it provides `storage.kv/v1` over the one SQLite file
//! `$DORIC_STORAGE_PATH/doric.sqlite3`, and `storage/v2`'s `Register`, `Commit`,
//! `Get`, `Query`, `Read`, `PutBlob`, `GetBlob`, `DeleteBlob`, `Health` and
//! `Watch`; it decodes the values of indexed types with each bundle's
//! descriptors, while the engine library reads no value.
//!
//! Every `storage.kv/v1` handler ([`kv`]) first refuses any caller but `doric`
//! (`not_owner`), then checks the counts, then each key's prefix and size
//! ([`doric_sqlite::limits`]), before it touches a connection. Commits go to
//! the engine's one writer thread; reads go to its four reader connections
//! ([`doric_sqlite::SqliteEngine`]).

use std::{
    ffi::OsString,
    path::PathBuf,
    process::ExitCode,
    sync::{Arc, OnceLock},
};

use doric_bundle::{Bundle, Call, ContractError, Level, Requests, Services};
use doric_sqlite::SqliteEngine;
use doric_storage::{
    blobs::{self, Upload},
    cache::{CACHE_VARIABLE, Headers},
    commit::{self, Batch},
    documents, health,
    register::{self, Registrations},
    schema::Pools,
    streams,
    v2::{
        CommitRequest, CommitResponse, DeleteBlobRequest, DeleteBlobResponse, GetBlobRequest,
        GetBlobResponse, GetRequest, GetResponse, HealthRequest, HealthResponse, PutBlobRequest,
        PutBlobResponse, ReadRequest, ReadResponse, RegisterRequest, RegisterResponse,
    },
    watch::Watchers,
};
use tokio_stream::{Stream, StreamExt, wrappers::ReceiverStream};

mod kv;

fn main() -> ExitCode {
    doric_bundle::run(Engine::default())
}

/// The bundle: the store it opens in its activation, shared with every
/// handler.
#[derive(Default, Clone)]
struct Engine {
    /// The open store; set once, by a successful [`Bundle::activate`], and
    /// never replaced.
    store: Arc<OnceLock<SqliteEngine>>,
    /// The highest generation that registered, per bundle, shared by every
    /// `Register` call of this process.
    registrations: Registrations,
    /// The clock of `updatedAt`, shared by every `storage/v2` commit.
    clock: commit::Clock,
    /// The decoded pools of stored schemas, shared by every `storage/v2`
    /// commit.
    pools: Pools,
    /// The cache of document headers that every `storage/v2` `Register` and
    /// `Commit` writes through; set once, by the activation that sets the
    /// store ([`Engine::headers`]).
    headers: Arc<OnceLock<Headers>>,
    /// The storage directory, `DORIC_STORAGE_PATH`; set once, by the
    /// activation that sets the store.
    dir: Arc<OnceLock<PathBuf>>,
    /// The watchers of every bundle, which each `storage/v2` commit publishes
    /// to once it commits.
    watchers: Watchers,
}

impl Bundle for Engine {
    /// Registers the three methods of `doric.storage.kv.v1.KvService`: `Get`
    /// and `Range`, server-streaming, and `Commit`, client-streaming; and
    /// `doric.storage.v2.StorageService`'s `Register`, unary, `Commit`,
    /// client-streaming, `Get`, `Query` and `Read`, server-streaming,
    /// `PutBlob`, client-streaming, `GetBlob`, server-streaming, `DeleteBlob`
    /// and `Health`, unary, and `Watch`, server-streaming.
    fn services(&self) -> Services {
        let (get, range, commit) = (self.clone(), self.clone(), self.clone());
        let (register, documents, read) = (self.clone(), self.clone(), self.clone());
        let (pages, entries) = (self.clone(), self.clone());
        let (health, put_blob) = (self.clone(), self.clone());
        let (get_blob, delete_blob, watch) = (self.clone(), self.clone(), self.clone());

        Services::new()
            .server_stream(
                "/doric.storage.kv.v1.KvService/Get",
                move |call, request| get.get(call, request),
            )
            .server_stream(
                "/doric.storage.kv.v1.KvService/Range",
                move |call, request| range.range(call, request),
            )
            .client_stream(
                "/doric.storage.kv.v1.KvService/Commit",
                move |call, requests| {
                    let commit = commit.clone();
                    async move { commit.commit(call, requests).await }
                },
            )
            .unary(
                "/doric.storage.v2.StorageService/Register",
                move |call, request| {
                    let register = register.clone();
                    async move { register.register(call, request).await }
                },
            )
            .client_stream(
                "/doric.storage.v2.StorageService/Commit",
                move |call, requests| {
                    let documents = documents.clone();
                    async move { documents.commit_documents(call, requests).await }
                },
            )
            .server_stream(
                "/doric.storage.v2.StorageService/Get",
                move |call, request| read.get_document(call, request),
            )
            .server_stream(
                "/doric.storage.v2.StorageService/Query",
                move |call, request| pages.query_documents(call, request),
            )
            .server_stream(
                "/doric.storage.v2.StorageService/Read",
                move |call, request| entries.read_stream(call, request),
            )
            .client_stream(
                "/doric.storage.v2.StorageService/PutBlob",
                move |call, requests| {
                    let put_blob = put_blob.clone();
                    async move { put_blob.put_blob(call, requests).await }
                },
            )
            .server_stream(
                "/doric.storage.v2.StorageService/GetBlob",
                move |call, request| get_blob.get_blob(call, request),
            )
            .unary(
                "/doric.storage.v2.StorageService/DeleteBlob",
                move |call, request| {
                    let delete_blob = delete_blob.clone();
                    async move { delete_blob.delete_blob(call, request).await }
                },
            )
            .unary(
                "/doric.storage.v2.StorageService/Health",
                move |call, request| {
                    let health = health.clone();
                    async move { health.health(call, request).await }
                },
            )
            .server_stream(
                "/doric.storage.v2.StorageService/Watch",
                move |call, request| watch.watch(call, request),
            )
    }

    /// Chooses the header cache from `DORIC_SQLITE_CACHE`
    /// ([`Headers::from_setting`]), then opens the store
    /// ([`doric_sqlite::open`]) in `DORIC_STORAGE_PATH`, the current directory
    /// when the variable is unset or empty, off the runtime's threads, and logs
    /// [`doric_sqlite::sqlite_version`] at `info` ([`Engine::activate_from`]).
    ///
    /// # Errors
    ///
    /// `invalid_input` (`details.variable` `"DORIC_SQLITE_CACHE"`) for a
    /// value other than unset, empty, `0` or `1`, before the open; then the
    /// error of [`doric_sqlite::open`]: `storage_path_missing`,
    /// `storage_format_unsupported` or `internal`. The store then stays unset.
    async fn activate(&self) -> Result<(), ContractError> {
        self.activate_from(
            std::env::var_os("DORIC_STORAGE_PATH"),
            std::env::var_os(CACHE_VARIABLE),
        )
        .await
    }

    /// Closes the store, if one is open ([`SqliteEngine::close`]): it waits for
    /// the commit in progress, checkpoints the WAL and closes every connection.
    async fn stop(&self) {
        if let Some(store) = self.store.get() {
            store.close().await;
        }
    }
}

impl Engine {
    /// The activation with `storage_path` as `DORIC_STORAGE_PATH` and `cache`
    /// as [`CACHE_VARIABLE`]: first [`Headers::from_setting`]`(cache)`, then
    /// the open as [`Bundle::activate`] gives it; on success the cache and
    /// the store are set, each once. A second activation keeps the first
    /// cache and store, and closes the store it opened.
    ///
    /// # Errors
    ///
    /// The `invalid_input` of [`Headers::from_setting`], before any open and
    /// with nothing set; then the errors of [`Bundle::activate`].
    async fn activate_from(
        &self,
        storage_path: Option<OsString>,
        cache: Option<OsString>,
    ) -> Result<(), ContractError> {
        let headers = Headers::from_setting(cache.as_deref())?;
        let dir = storage_path
            .filter(|path| !path.is_empty())
            .map_or_else(|| PathBuf::from("."), PathBuf::from);
        let opened = dir.clone();
        let store = tokio::task::spawn_blocking(move || doric_sqlite::open(&opened))
            .await
            .map_err(|error| {
                ContractError::new("internal", format!("The open failed: {error}."))
            })??;

        doric_bundle::log(
            Level::Info,
            &format!("SQLite {} is open.", doric_sqlite::sqlite_version()),
        );
        // A second activation keeps the first cache and store, so the store
        // it opened is closed.
        let _ = self.headers.set(headers);
        let _ = self.dir.set(dir);
        if let Err(store) = self.store.set(store) {
            store.close().await;
        }
        Ok(())
    }

    /// The cache the activation chose; [`Headers::default`] when none has
    /// been set, as for a store set without an activation, which then stays.
    fn headers(&self) -> &Headers {
        self.headers.get_or_init(Headers::default)
    }

    /// The open store.
    ///
    /// # Errors
    ///
    /// `unavailable` before a successful activation.
    fn store(&self) -> Result<&SqliteEngine, ContractError> {
        self.store
            .get()
            .ok_or_else(|| ContractError::new("unavailable", "The engine is not active."))
    }

    /// Serves `Register`: [`register::prepare`](doric_storage::register::prepare),
    /// then [`Engine::store`] (`unavailable` before activation), then
    /// [`Registrations::apply`]; answers `RegisterResponse {}`.
    ///
    /// # Errors
    ///
    /// The first error of the three, in that order; a refusal of `prepare`
    /// touches no connection.
    async fn register(
        &self,
        call: Call,
        request: RegisterRequest,
    ) -> Result<RegisterResponse, ContractError> {
        let registration = register::prepare(&call.caller, request.descriptor_set)?;
        let store = self.store()?;
        let applied = self
            .registrations
            .apply(store, self.headers(), registration);
        for rebuilt in applied.await? {
            doric_bundle::log(Level::Info, &rebuilt.to_string());
        }
        Ok(RegisterResponse {})
    }

    /// Serves `storage/v2`'s `Commit`: [`doric_storage::bundle`], then each
    /// item into a [`Batch`] as it arrives, then, once the stream ends,
    /// [`Batch::finish`], [`Engine::store`] and [`commit::apply`]; answers the
    /// commit's position.
    ///
    /// # Errors
    ///
    /// The refusal of `bundle` answers before any item is read; the first
    /// refusal of [`Batch::push`], or an `Err` item, answers at once, and
    /// nothing is written. Then the refusal of `finish`, `unavailable` before
    /// activation, and the errors of `apply`. A cancelled call writes nothing
    /// unless the writer has already begun its transaction.
    async fn commit_documents(
        &self,
        call: Call,
        mut requests: Requests<CommitRequest>,
    ) -> Result<CommitResponse, ContractError> {
        let mut batch = Batch::new(doric_storage::bundle(&call.caller)?);
        while let Some(request) = requests.next().await {
            batch.push(request?)?;
        }
        // A cancelled call ends its stream early: what arrived is not the
        // whole commit.
        if call.cancelled.is_cancelled() {
            return Err(kv::cancelled());
        }
        let items = batch.finish()?;
        let store = self.store()?;

        tokio::select! {
            biased;
            () = call.cancelled.cancelled() => Err(kv::cancelled()),
            position = commit::apply(store, &self.clock, &self.pools, self.headers(), &self.watchers, items) => {
                Ok(CommitResponse { position: position? })
            }
        }
    }

    /// Serves `storage/v2`'s `Get`: [`doric_storage::bundle`],
    /// [`documents::check`] and [`Engine::store`], then, in a spawned task,
    /// [`documents::get`] in one read transaction, whose items it streams.
    ///
    /// # Errors
    ///
    /// The stream's one item is the first refusal of the three, and no
    /// connection is touched; otherwise its last item is the error of the
    /// read, after the items already emitted.
    fn get_document(
        &self,
        call: Call,
        request: GetRequest,
    ) -> ReceiverStream<Result<GetResponse, ContractError>> {
        let checked = doric_storage::bundle(&call.caller).and_then(|bundle| {
            documents::check(bundle, &request)?;
            self.store()?;
            Ok(bundle.to_owned())
        });
        let bundle = match checked {
            Ok(bundle) => bundle,
            Err(error) => return kv::refused(error),
        };
        self.stream_read(move |txn, emit| documents::get(txn, &bundle, &request, emit))
    }

    /// Serves `storage/v2`'s `Read`: [`doric_storage::bundle`],
    /// [`streams::check`] and [`Engine::store`], then, in a spawned task,
    /// [`streams::read`] in one read
    /// transaction, whose items it streams.
    ///
    /// # Errors
    ///
    /// The stream's one item is the first refusal of the three, and no
    /// connection is touched; otherwise its last item is the error of the
    /// read, after the items already emitted.
    fn read_stream(
        &self,
        call: Call,
        request: ReadRequest,
    ) -> ReceiverStream<Result<ReadResponse, ContractError>> {
        let checked = doric_storage::bundle(&call.caller).and_then(|bundle| {
            let read = streams::check(bundle, &request)?;
            self.store()?;
            Ok((bundle.to_owned(), read))
        });
        let (bundle, read) = match checked {
            Ok(checked) => checked,
            Err(error) => return kv::refused(error),
        };
        self.stream_read(move |txn, emit| streams::read(txn, &bundle, &read, emit))
    }

    /// Serves `storage/v2`'s `Health`: [`doric_storage::bundle`], then
    /// [`Engine::store`], then [`health::measure`](doric_storage::health::measure)
    /// of the activation's `DORIC_STORAGE_PATH`.
    ///
    /// # Errors
    ///
    /// The refusal of `bundle`, then `unavailable` before activation.
    async fn health(
        &self,
        call: Call,
        request: HealthRequest,
    ) -> Result<HealthResponse, ContractError> {
        let _ = request;
        doric_storage::bundle(&call.caller)?;
        self.store()?;
        let dir = self
            .dir
            .get()
            .cloned()
            .unwrap_or_else(|| PathBuf::from("."));
        let storage_health = tokio::task::spawn_blocking(move || health::measure(&dir))
            .await
            .map_err(|error| {
                ContractError::new("internal", format!("The measure failed: {error}."))
            })?;
        Ok(HealthResponse {
            storage_health: Some(storage_health),
        })
    }

    /// Serves `storage/v2`'s `PutBlob`: [`doric_storage::bundle`], then each
    /// chunk into an [`Upload`](doric_storage::blobs::Upload) as it arrives,
    /// then, once the stream ends, [`Engine::store`] and
    /// [`blobs::put`](doric_storage::blobs::put); answers the blob's hash.
    ///
    /// # Errors
    ///
    /// The refusal of `bundle` before any chunk is read; the first refusal
    /// of the upload, or an `Err` item, at once, and nothing is written; then
    /// `unavailable` before activation, and the errors of `put`.
    async fn put_blob(
        &self,
        call: Call,
        mut requests: impl Stream<Item = Result<PutBlobRequest, ContractError>> + Unpin + Send,
    ) -> Result<PutBlobResponse, ContractError> {
        let bundle = doric_storage::bundle(&call.caller)?;
        let mut upload = Upload::new();
        while let Some(request) = requests.next().await {
            upload.push(request?.chunk)?;
        }
        // A cancelled call ends its stream early: what arrived is not the
        // whole blob.
        if call.cancelled.is_cancelled() {
            return Err(kv::cancelled());
        }
        let hash = blobs::put(self.store()?, self.headers(), bundle, upload).await?;
        Ok(PutBlobResponse { hash })
    }

    /// Serves `storage/v2`'s `GetBlob`: [`doric_storage::bundle`] and
    /// [`Engine::store`], then, in a spawned task,
    /// [`blobs::get`](doric_storage::blobs::get) in one read transaction,
    /// whose items it streams.
    ///
    /// # Errors
    ///
    /// The stream's one item is the first refusal of the two, and no
    /// connection is touched; otherwise its last item is the error of the
    /// read, after the items already emitted.
    fn get_blob(
        &self,
        call: Call,
        request: GetBlobRequest,
    ) -> ReceiverStream<Result<GetBlobResponse, ContractError>> {
        let checked = doric_storage::bundle(&call.caller).and_then(|bundle| {
            self.store()?;
            Ok(bundle.to_owned())
        });
        let bundle = match checked {
            Ok(bundle) => bundle,
            Err(error) => return kv::refused(error),
        };
        self.stream_read(move |txn, emit| blobs::get(txn, &bundle, &request.hash, emit))
    }

    /// Serves `storage/v2`'s `DeleteBlob`: [`doric_storage::bundle`], then
    /// [`Engine::store`], then [`blobs::delete`](doric_storage::blobs::delete).
    ///
    /// # Errors
    ///
    /// The refusal of `bundle`, then `unavailable` before activation, then
    /// the errors of `delete`.
    async fn delete_blob(
        &self,
        call: Call,
        request: DeleteBlobRequest,
    ) -> Result<DeleteBlobResponse, ContractError> {
        let bundle = doric_storage::bundle(&call.caller)?;
        blobs::delete(self.store()?, self.headers(), bundle, &request.hash).await?;
        Ok(DeleteBlobResponse {})
    }
}

#[path = "main/reads.rs"]
mod reads;
#[path = "main/watch.rs"]
mod watch;

#[cfg(test)]
#[path = "testing.rs"]
#[allow(dead_code, reason = "the library's tests use the rest")]
mod testing;

/// S77a2: the `Register` handler's order of checks (T4.24); S77a4b: the
/// activation's cache setting; S78b: `Health` and the blob methods before
/// activation.
#[cfg(test)]
#[path = "main/tests.rs"]
mod tests;
