# sqlite

Apply these rules to `bundles/foundation/sqlite/`, after the root
[`AGENTS.md`](../../../AGENTS.md) and [`bundles/AGENTS.md`](../../AGENTS.md).
This bundle is two Rust crates in one Nx project, `engine/` (the library
`doric-sqlite`) and `storage/` (the package `doric-storage`, binary
`doric-sqlite`), so these sections of `bundles/AGENTS.md` do not
apply to it: "Tests" (`tests/*.test.ts`), "Contracts module" and "Parts". Of
"Manifest and package", every rule on `manifest.json` (`id`, `provides`,
`requires`, `optional`, `doric.*` ids, `engines.doric`) applies; the two rules
on listing and removing `package.json` dependencies do not, since the two crates
import no package. `sqlite` is tagged `type:rust` and `type:bundle`, so that "Verify" includes
it; verify its two crates with:

```sh
npx nx run-many -t lint test check build format-check compile -p sqlite
npx nx run storage:test
npx nx run storage:test-heavy
```

RK27's measurements are not a test and verify nothing; run them, report-only
(up to 30 minutes), with:

```sh
npx nx run storage:bench-rk27
```

`rk27.ts`'s (a) backfills exactly the `rebuild` limit (`backfillDocuments =
100_000`, `REBUILD_DOCUMENTS` in `storage/src/register.rs`): a change to
`REBUILD_DOCUMENTS` must change that literal, or the engine refuses the
backfill and the CI step fails.

`storage:test` runs the KV kit (T4.2) and the storage-file tests (T4.18) on
the engine, `test-engine.test.ts` (T4.20) `openTestEngine` and
`kv-client.test.ts` the `kvClient` adapter, `storage-client.test.ts` the
`storage/v2` client, `storage.test.ts`, `storage-instances.test.ts` and
`registration.test.ts` the `storage/v2` conformance kit, which exercises every
`storage/v2` handler but `Watch`, none skipped, and `watch.test.ts` (T4.26)
`Watch`, which the kit does not exercise; `sqlite:test` runs the unit tests of both crates; `storage:test-heavy` runs the kit's heavy cases, the commits of
200,001 items, which take minutes; `storage:bench-rk27` builds the release binary
(`sqlite:compile:production`) and runs RK27's write-stall measurements over
`testEngineBinary('release')`, report-only (not a test). `index-parity.test.ts` (T4.23), in
`storage:test`, checks the TypeScript index keys against the golden file.

## Function

This bundle holds all of storage (A79). The library `doric-sqlite` is the
SQLite engine of `storage.kv/v1`: it stores keys and values and reads no value.
The package `doric-storage` is the storage layer above it: it decodes the values
of indexed types with each bundle's registered descriptors (`storage/src/schema.rs`), owns the
index-key encoding (`storage/src/keys.rs`) and serves `storage/v2`'s
`Register` (`storage/src/register.rs`, S77a2), `Commit` (`storage/src/commit.rs`),
`Get` (`storage/src/documents.rs`, S77a3a) and `Query` (`storage/src/query.rs`,
S77a3b), `Read` (`storage/src/streams.rs`, S78a), and `PutBlob`, `GetBlob`,
`DeleteBlob` (`storage/src/blobs.rs`) and `Health` (`storage/src/health.rs`,
S78b), and `Watch` (`storage/src/watch.rs`, `storage/src/main/watch.rs`,
S78c). It keeps no cache of document headers or stream heads: S78d removed
the cache of A80 (A84), and `DORIC_SQLITE_CACHE` is gone; activation reads only
`DORIC_STORAGE_PATH`.
Add to it no slot, route or record type of its own; what a record means belongs
to the bundle that registers its descriptors.

## Rules

- Read [`README.md`](README.md) for the file, its format, the errors and the
  limits before changing the bundle, and keep every change equivalent to it or
  update it in the same change.
- Change the shape of `storage.kv/v1` only in
  `packages/bundle/proto/doric/storage/kv/v1/kv.proto`, never in this bundle.
- Keep `#![forbid(unsafe_code)]` in `storage/src/main.rs`,
  `storage/src/lib.rs` and `engine/src/lib.rs`.
- Serve `storage.kv/v1` only to the caller `doric`: refuse any other caller
  with `not_owner` before any limit, store or I/O.
- Do no blocking work in a handler or in `activate` before its first `.await`
  (the S72 rule for Rust handlers).
- Run every `rusqlite` call on the writer thread ([`engine/src/writer.rs`](engine/src/writer.rs))
  or on `tokio::task::spawn_blocking`, never on the runtime's threads.
- Keep the guarantees of the KV contract: check the caller's prefix and the
  limits before any transaction opens, so a refused call reads and writes
  nothing; keep one writer, so positions are consecutive and a commit is all or
  none; keep reads on the read-only connections, each a snapshot; keep
  streams bounded.
- Read `user_version` before changing the file, and never change a file whose
  format this engine does not know.
- Keep `storage/src/keys.rs` the owner of the index-key encoding. After a
  change to it, to `storage/src/schema.rs` or to
  `storage/tests/fixtures/index_keys.proto`, regenerate
  `storage/tests/fixtures/index-keys.json` with
  `DORIC_WRITE_GOLDEN=1 cargo test -p doric-storage --lib` and run
  `storage:test`.
- Write tests as unit tests of the modules they test (`#[cfg(test)] mod tests`),
  in the module's `<module>/tests.rs` (or `tests/*.rs`) when the module would
  pass 500 lines, as `engine/src/{writer,store,limits,readers}/tests.rs` and
  `storage/src/main/tests.rs` (declared with `#[path]`) are.
- Make every write of `doric-storage` read a document header through
  `documents::stored_header` and a stream head through
  `streams::last_sequence`, inside the writer's transaction, which sees its own
  writes; keep no cache or overlay of them (A84, S78d).
- Publish `Watch` changes only through `txn.on_commit`, so a change reaches
  watchers only after `COMMIT` and a rollback publishes nothing.
- Keep `storage.kv/v1` commits (`engine/src/writer.rs`'s `run`) from reading or
  storing `data_version`; only `transact` does.
- Read only `DORIC_STORAGE_PATH` in `activate`, with `std::env::var_os`, and
  pass it to `activate_from`; tests call `activate_from` with the value, never
  `set_var`, which `forbid(unsafe_code)` with edition 2024 forbids.
- Serve the `storage/v2` methods other than `Import`, `Inspect` and `Check`
  to bundles only: refuse the caller `doric` with `not_owner`. `Import`,
  `Inspect` and `Check` are `doric`-only (S87–S88).
- Change the engine's own records only in
  `proto/doric/storage/layout/v1/layout.proto`, generated for Rust only by
  `storage/build.rs`.
- Keep every source file under 500 lines.
