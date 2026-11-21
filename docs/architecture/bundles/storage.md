# Storage and history

- Status: living document. It describes durable storage and the storage of a Thread's history as implemented on 2026-11-20.

## Summary

Durable storage is two service contracts. `storage.backend/v1` is the backend: versioned documents with declared indexes, ordered streams, atomic declarative commits, a commit feed, content-addressed blobs, health and the host's storage identity, with no knowledge of Projects, Threads or their events. `storage/v1` is the facade bundles use: it identifies types and streams by qualified ids, lets each bundle reach only its own data, validates every written value with the type's zod schema and refuses a batch over the backend's limits before sending it. The core bundle provides `storage/v1`; the `postgres` bundle provides `storage.backend/v1` in the shipped host, over PostgreSQL through Prisma, together with `secrets.backend/v1` ([`composition.json`](../../../app/backend/doric-host/composition.json), [`postgres/manifest.json`](../../../bundles/foundation/postgres/manifest.json)). The library package `storage` holds the protocol both sides share: index-key encoding, cursors, stream ids, batch limits, in-memory backends and the conformance kit every backend passes.

A bundle defines each type it stores with `defineStorageType` and remains the owner of the operations that interpret it. A Thread's history is the `runtime` bundle's: an event stream per Thread and documents beside it, in the same backend. On the desktop, the `history` bundle keeps a disposable local snapshot of it, keyed by the host's storage identity.

## The two contracts

| Contract                   | Cardinality | Shipped provider                      | Who uses it                                                                                    | Full shape                                                                                     |
| -------------------------- | ----------- | ------------------------------------- | ---------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `storage.backend/v1@1.1.0` | `one`       | `postgres`, in the `host` environment | the core's `storage/v1` and its start step, and the platform, which reads the storage identity | [postgres README](../../../bundles/foundation/postgres/README.md#storagebackendv1-version-110) |
| `storage/v1@1.1.0`         | `one`       | `core`, in the `host` environment     | bundles that list it under `requires`: `runtime` and `mcp` in the shipped composition          | [core README](../../../bundles/foundation/core/README.md#storagev1)                            |

Both references and their method schemas are exported by `bundle/contracts` ([`basic/storage.ts`](../../../packages/bundle/src/contracts/basic/storage.ts)). Inside the core, only the `storage/v1` facade and the start step call the backend ([`core/src/host/storage/facade.ts`](../../../bundles/foundation/core/src/host/storage/facade.ts), [`core/src/host/secrets/activation.ts`](../../../bundles/foundation/core/src/host/secrets/activation.ts)). `runtime` and `mcp` list `storage/v1@^1.1.0` under `requires` ([`runtime/manifest.json`](../../../bundles/runtime/runtime/manifest.json), [`mcp/manifest.json`](../../../bundles/features/mcp/manifest.json)).

### Foundation and activation order

The composition chooses the backend under `providers`; the shipped host chooses `postgres` for `storage.backend/v1` and `secrets.backend/v1` ([`composition.json`](../../../app/backend/doric-host/composition.json)). The core lists exactly those two contracts under `requires` ([`core/manifest.json`](../../../bundles/foundation/core/manifest.json)), so their chosen provider joins the **foundation**: the loader activates the foundation bundles that provide a storage or secrets backend first, then the rest of the foundation, then the core, then every other bundle ([`catalog.ts`](../../../packages/bundle/src/runtime/catalog.ts)). A foundation bundle that lists any contract under `requires` is quarantined with `foundation_requires`; only a replacement of `events/v1`, `settings/v1` or `models/v1` may require `storage.backend/v1` and `secrets.backend/v1`. A chosen foundation provider that is quarantined puts the environment in recovery mode instead of falling back to another provider ([`catalog.ts`](../../../packages/bundle/src/runtime/catalog.ts)). [Core](core.md) describes the foundation, the core's own requirements and recovery mode in full.

`postgres` therefore uses no contract of the core: its manifest has an empty `requires` ([`postgres/manifest.json`](../../../bundles/foundation/postgres/manifest.json)). Neither `postgres` nor the core performs I/O during activation: `postgres` creates its database client on first use, and the core declares a type to the backend only when the first operation on it runs ([`postgres.ts`](../../../bundles/foundation/postgres/src/host/postgres.ts), [`core/src/host/storage/facade.ts`](../../../bundles/foundation/core/src/host/storage/facade.ts)).

`storage/v1` has no `doric.` prefix, so a composition may choose another provider for it under `providers`; the core's `provide` then registers nothing, and the core reaches the chosen provider through the same contract ([Core](core.md#replacing-a-contract-the-core-provides)).

## Data model

### Document types

A storage type is a contract id of the owning bundle's namespace, such as `runtime.thread/v1`, defined in that bundle's `contracts` entry point with `defineStorageType({ type, schema, indexes })` from `bundle/contracts`. The schema is a zod object; each index is `{ name, fields, unique? }`, whose fields are dotted property paths of the schema ([`define.ts`](../../../packages/bundle/src/contracts/define.ts)). For example, `runtime` defines `runtime.thread/v1` with the indexes `byProject` (`projectId`, `createdKey`), `byParent` (`projectId`, `parentThreadId`, `createdKey`) and `byOpen` (`open`, `createdKey`) ([`runtime/src/contracts/storage.ts`](../../../bundles/runtime/runtime/src/contracts/storage.ts)).

At activation the bundle registers each type with `services.use(StorageV1).defineType(definition)`, which returns a disposable. `storage/v1` accepts the definition only when the type's namespace (the id up to its first `.` or `/`) is the calling bundle's id (`not_owner` otherwise) and the bundle lists the type under `provides` with its version (`undeclared_provide` otherwise), as `runtime` lists `runtime.thread/v1@1.3.0` ([`core/src/shared/state.ts`](../../../bundles/foundation/core/src/shared/state.ts), [`runtime/manifest.json`](../../../bundles/runtime/runtime/manifest.json)). Index names must be unique and every index field must name a place the schema can hold (`invalid_input`) ([`validate.ts`](../../../bundles/foundation/core/src/host/storage/validate.ts)). The same owner may define the same type again with the same generated JSON Schema and indexes and gets another handle; any other second definition is `registration_conflict`; the type leaves when every handle is disposed ([`registry.ts`](../../../bundles/foundation/core/src/host/storage/registry.ts)).

A stored document is `{ type, id, revision, value }`. The first `put` writes revision 1 and each later `put` raises it by one ([`commit.ts`](../../../bundles/foundation/postgres/src/host/storage/commit.ts)). The facade sends a type's index declaration to the backend (`declareType`) once, before the first `get`, `query` or `commit` that touches the type, and retries it on the next operation when it fails ([`facade.ts`](../../../bundles/foundation/core/src/host/storage/facade.ts)). A changed declaration rebuilds the index entries of every stored document of the type in one transaction; a declaration never deletes a document ([`declare.ts`](../../../bundles/foundation/postgres/src/host/storage/declare.ts)). Documents of a type no active bundle defines stay stored: `storage/v1` answers `unknown_type` to a bundle that asks for one, and only the platform reads it ([`facade.ts`](../../../bundles/foundation/core/src/host/storage/facade.ts)).

### Indexes and queries

There is no free query. `query` reads one declared index: `equals` gives values for its leading fields, `range` (`gt` or `gte`, `lt` or `lte`) bounds the next field, `order` is `asc` or `desc`, `limit` is 1 to 1000, and a page carries a `cursor` while more items follow ([`basic/storage.ts`](../../../packages/bundle/src/contracts/basic/storage.ts), [`keys.ts`](../../../packages/storage/src/keys.ts)). An index field is read from the value by JSON Pointer (`a.b` is `/a/b`); a missing path indexes as `null`, and an object or array is `invalid_index_value` ([`keys.ts`](../../../packages/storage/src/keys.ts)).

Every backend orders index keys the same way, by the encoding of [`keys.ts`](../../../packages/storage/src/keys.ts): `null` < `false` < `true` < numbers < strings; numbers by value, with `-0` equal to `0` and non-finite numbers refused; strings bytewise in UTF-8, with a lone surrogate refused; ties broken by document id, bytewise in UTF-8. PostgreSQL keeps the encoded key as `bytea` and compares ids with `COLLATE "C"` to match ([`postgres README`](../../../bundles/foundation/postgres/README.md#schema)).

### Streams

A stream id is `<owner>.<family>/<key>`: a qualified family name whose first segment is the owning bundle, a slash, and a key without whitespace; any other id is `invalid_stream` ([`streams.ts`](../../../packages/storage/src/streams.ts)). Each Thread's events, for example, are the stream `runtime.thread.events/<threadId>` ([`runtime/src/contracts/storage.ts`](../../../bundles/runtime/runtime/src/contracts/storage.ts)).

An append gives each event the next sequence, starting at 1, and a protocol timestamp `createdAt` (ISO-8601, milliseconds, UTC) set by the backend at commit. The stream's counter `lastSequence` never decreases: a truncation removes the entries after `afterSequence` and records a truncation mark `{ afterSequence, atSequence }`, where `atSequence` is the counter at the end of that commit, appends of the same batch included; removed sequences are never reused. `read({ stream, afterSequence, limit })` answers the entries after `afterSequence`, the counter, and the marks with `afterSequence < request.afterSequence <= atSequence`, the truncations that removed entries this reader may already hold, all from one snapshot; reading past the counter is `invalid_input`, and a stream that does not exist reads as empty at 0. `dropStreams` removes whole streams with their entries and marks ([`basic/storage.ts`](../../../packages/bundle/src/contracts/basic/storage.ts), [`streams.ts`](../../../bundles/foundation/postgres/src/host/storage/streams.ts), [`commit.ts`](../../../bundles/foundation/postgres/src/host/storage/commit.ts)).

### Commits

A write is one declarative batch, applied atomically in this order, or not at all: `expect` (`{ type, id, revision }`, revision 0 meaning "must not exist"), `delete`, `put`, `dropStreams`, `truncate` (one stream), `append` (`{ stream, expectedSequence?, events }`, at least one event). A successful commit answers its feed `position` ([`basic/storage.ts`](../../../packages/bundle/src/contracts/basic/storage.ts)). No model, tool, sandbox or network call happens inside a commit: the caller reads, computes and sends the batch. A conflict is a typed error, and the caller decides whether to read again and retry, as the `runtime` bundle's document store does ([`runtime/src/host/store/documents.ts`](../../../bundles/runtime/runtime/src/host/store/documents.ts)). A failed batch leaves no document, index entry, stream entry, truncation mark or feed entry behind and takes no position ([`commit.ts`](../../../bundles/foundation/postgres/src/host/storage/commit.ts)).

Before sending a batch, `storage/v1` checks that the caller owns every type in `expect`, `delete` and `put`; parses every `put` value with the type's schema and stores the parsed output; allows `dropStreams`, `truncate` and `append` only on streams whose first segment is the caller, unless the caller is the active `events/v1` provider or the platform; and refuses the batch against the backend's capabilities ([`facade.ts`](../../../bundles/foundation/core/src/host/storage/facade.ts)). `read` is allowed only to the stream's owner and the platform; `get` and `query` only to the type's owner and the platform ([`facade.ts`](../../../bundles/foundation/core/src/host/storage/facade.ts)). The platform principal is `doric`.

The backend reports its limits with `capabilities()`: `maxBatch` items, `maxDocumentBytes` per `put` value and `maxAppendBytes` per appended event. A batch counts `expect`, `put`, `delete` and `dropStreams` entries, one for `truncate` and each appended event. An empty batch is `invalid_input`; a batch over a limit is `limit_exceeded`, refused before anything is written, by the facade and again by the backend ([`batch.ts`](../../../packages/storage/src/batch.ts)). The defaults are 10 000 items and 268 435 455 bytes, the PostgreSQL `jsonb` ceiling, per document and per event ([`batch.ts`](../../../packages/storage/src/batch.ts)).

### The commit feed, blobs, health and identity

- **Feed.** Each commit writes one feed entry in commit order, with gapless positions: the `{ type, id }` keys it put or deleted and the streams it appended to, truncated and dropped. `storage.backend/v1.feed({ after, limit })` reads it; `storage/v1` does not expose it ([`feed.ts`](../../../bundles/foundation/postgres/src/host/storage/feed.ts), [`basic/storage.ts`](../../../packages/bundle/src/contracts/basic/storage.ts)).
- **Blobs.** `putBlob` takes base64 bytes and answers `sha256:<hex>`; storing the same bytes again is a no-op. `getBlob` answers the bytes or `undefined`, and `deleteBlob` of an unknown or malformed hash is a no-op. Blobs are shared by every bundle: who may read one is the caller's own record of it, as `runtime` keeps a `runtime.attachment/v1` document per attached image ([`blobs.ts`](../../../bundles/foundation/postgres/src/host/storage/blobs.ts), [`runtime/src/contracts/storage.ts`](../../../bundles/runtime/runtime/src/contracts/storage.ts)).
- **Health.** `health()` answers measurements only: `{ status: 'ok', writable: true, disk: { blocks, availableBlocks } }`, or `{ status: 'unavailable', writable: false, reason: 'storage_unmeasurable' }` when the filesystem cannot be measured. `postgres` measures the filesystem at `DORIC_STORAGE_PATH` (the current directory when unset) with `statfs`, with no database round trip, so a database outage is never reported as low storage ([`health.ts`](../../../bundles/foundation/postgres/src/host/storage/health.ts)). The policy belongs to the caller: `runtime` treats 10 % of available blocks or less as low storage and pauses the Thread ([runtime README](../../../bundles/runtime/runtime/README.md#storage-pressure)).
- **Identity.** `identity()` answers `{ hostId, storageGeneration }`, a UUID and a positive integer kept in a reserved record of the backend; the first call creates it with a random `hostId` and `storageGeneration` 1, and every later call over the same database answers the same ([`identity.ts`](../../../bundles/foundation/postgres/src/host/storage/identity.ts)). After the host's start steps, the platform reads it once and publishes it in `doric.catalog/v1` as the snapshot's `storage` field ([`kernel.ts`](../../../packages/bundle/src/process/kernel.ts), [Core](core.md#doriccatalogv1)).

The error codes of both contracts are `revision_conflict` (an `expect` does not match, with `{ type, id, expected, actual }`), `sequence_conflict` (an append's `expectedSequence` is not the stream's counter), `unique_conflict`, `limit_exceeded`, `invalid_index_value`, `invalid_stream`, `invalid_input`, and, from `storage/v1` only, `unknown_type` and `not_owner`; nothing of a batch applies when one is raised ([`basic/storage.ts`](../../../packages/bundle/src/contracts/basic/storage.ts)).

## The PostgreSQL backend

### Client and start

`postgres` keeps the process's single Prisma ORM 7 client, built over `@prisma/adapter-pg` from `DORIC_DATABASE_URL` on the first call that needs it; a missing URL rejects that call with "DORIC_DATABASE_URL is required." and the next call fails the same way. Every `storage.backend/v1` method runs on that client except `health` and `capabilities`, and the bundle's deactivation disconnects it ([`prisma.ts`](../../../bundles/foundation/postgres/src/prisma.ts), [`database.ts`](../../../bundles/foundation/postgres/src/host/database.ts), [`backend.ts`](../../../bundles/foundation/postgres/src/host/storage/backend.ts)).

The database is opened at the host's start, not at activation. The core's start step on `onHostStartHook` first calls `storage.backend/v1.connect`, which enters the startup stage `database_client` through `doric.startup/v1`, connects the client and checks the database; then the core enters `credential_activation` and reads the stored credentials once ([`core/src/host/secrets/activation.ts`](../../../bundles/foundation/core/src/host/secrets/activation.ts), [`start.ts`](../../../bundles/foundation/postgres/src/host/start.ts)). The check refuses a database in which the tables `project`, `thread` and `thread_event` all exist and one of them holds a row, with "Legacy Project and Thread data has not been migrated; run prisma migrate deploy."; the schema the migrations leave has none of these tables, so the host never serves an empty history over data it cannot read. When the database cannot answer the check, the check passes and the first query that needs the database fails ([`database.ts`](../../../bundles/foundation/postgres/src/host/database.ts)). A failure of `connect` fails the host at its stage.

### Tables

The storage backend keeps every primitive in `storage_*` tables, which it reads and writes with raw SQL ([`storage/`](../../../bundles/foundation/postgres/src/host/storage/)):

| Table                  | Holds                                                                                           |
| ---------------------- | ----------------------------------------------------------------------------------------------- |
| `storage_meta`         | reserved records by key; `identity` holds the storage identity                                  |
| `storage_type`         | each type's index declarations, as the last `declareType` wrote them                            |
| `storage_document`     | documents by `(type, id)`, with `revision` and `value jsonb`                                    |
| `storage_index_entry`  | one encoded key per document and declared index; a partial unique index enforces unique indexes |
| `storage_stream`       | each stream's `last_sequence`                                                                   |
| `storage_stream_entry` | stream entries by `(stream, sequence)`, with `value jsonb` and `created_at`                     |
| `storage_commit`       | the feed: one row per commit by `position`                                                      |
| `storage_truncation`   | truncation marks by `(stream, position)`                                                        |
| `storage_blob`         | blobs by `hash`                                                                                 |

The secrets backend keeps the `credential` table, which it reads and writes through the generated client, sealing each secret in an AES-256-GCM envelope under `DORIC_CREDENTIAL_KEY` ([`secrets/table.ts`](../../../bundles/foundation/postgres/src/host/secrets/table.ts), [`secrets/backend.ts`](../../../bundles/foundation/postgres/src/host/secrets/backend.ts)). No foreign key links `credential` to any other table, and the configuration, being a document, has no foreign keys at all ([`schema.prisma`](../../../bundles/foundation/postgres/prisma/schema.prisma)). The columns, keys and constraints of every table are in the [postgres README](../../../bundles/foundation/postgres/README.md#schema).

### What PostgreSQL stores

Everything durable on the host is in this database:

- the configuration, as the `settings/v1` space `host-config.configuration/v1`: one `core.settings/v1` document whose id is that settings id, beside the `core.settings-generation/v1` counter ([`core/src/contracts/storage.ts`](../../../bundles/foundation/core/src/contracts/storage.ts), [`host-config/src/host/configuration.ts`](../../../bundles/foundation/host-config/src/host/configuration.ts));
- the stored credentials, in `credential`;
- the `runtime` bundle's documents and streams: Projects (`runtime.project/v1`, with their names, colors and configuration snapshots), Threads (`runtime.thread/v1`, with names, parentage and usage), the executor's provider history (`runtime.history/v1`), attachments (`runtime.attachment/v1`) and the ordered events of each Thread ([`runtime/src/contracts/storage.ts`](../../../bundles/runtime/runtime/src/contracts/storage.ts));
- the documents of other bundles that define types, such as `mcp.server/v1` ([`mcp/src/host/store.ts`](../../../bundles/features/mcp/src/host/store.ts)).

The host README lists every record with its id and indexes ([host README](../../../app/backend/doric-host/README.md#database)).

### Schema and migrations

`postgres` owns the Prisma schema, its versioned migrations and the generated client: [`prisma/schema.prisma`](../../../bundles/foundation/postgres/prisma/schema.prisma), [`prisma/migrations`](../../../bundles/foundation/postgres/prisma/migrations) (one `migration.sql` per directory, applied in name order) and the untracked `src/generated/prisma`. The schema's models mirror the tables; the migrations also hold what Prisma cannot express: `COLLATE "C"` on the key columns, the partial unique index of unique index entries and the positive revision check ([`schema.prisma`](../../../bundles/foundation/postgres/prisma/schema.prisma)).

[`app/backend/doric-host/prisma.config.ts`](../../../app/backend/doric-host/prisma.config.ts) points the Prisma CLI at that schema and those migrations, with the datasource `DORIC_DATABASE_URL`, or `postgresql://doric:doric@127.0.0.1:5432/doric` when it is unset. Every command that applies or generates goes through it: `npx nx run doric-host:migrate` runs `prisma migrate deploy` ([`project.json`](../../../app/backend/doric-host/project.json)), the Compose `migrate` service runs the same command before either host service starts ([`compose.yaml`](../../../app/backend/doric-host/compose.yaml)), and the image build runs `prisma generate` with it ([`.Dockerfile`](../../../app/backend/doric-host/.Dockerfile)). The bundle's own [`prisma.config.ts`](../../../bundles/foundation/postgres/prisma.config.ts) points at the same files from the bundle's directory. The host never applies a migration at startup.

An existing database is never reset implicitly. Startup refuses a database it cannot read, as [Client and start](#client-and-start) states, and a migration that meets rows it cannot carry stops with an error and leaves the database as it was: `prisma migrate deploy` stops while `project`, `thread` or `thread_event` hold a row ([`20261117000000_drop_legacy_runtime_tables/migration.sql`](../../../bundles/foundation/postgres/prisma/migrations/20261117000000_drop_legacy_runtime_tables/migration.sql)). Recreating or repairing such a database is an explicit step of the operator; the [host README](../../../app/backend/doric-host/README.md#database) gives the steps.

## The `storage` package

[`packages/storage`](../../../packages/storage/README.md) (npm `storage`) is the protocol package of `storage.backend/v1`. Its entry points are:

- `storage`: the index-key encoding and its bounds, query cursors, stream-id parsing, the conflict and limit errors, and the batch accounting with the default capabilities ([`index.ts`](../../../packages/storage/src/index.ts));
- `storage/memory`: in-memory `storage.backend/v1` and `secrets.backend/v1`, the executable reference of the protocol, and `memoryFoundation`, an embedded foundation for core and kernel tests; never part of a shipped composition ([`memory/index.ts`](../../../packages/storage/src/memory/index.ts));
- `storage/conformance`: the kit every storage backend passes, with cases for documents, concurrency, revision conflicts, paginated queries, sequences with gaps, snapshot and cursor, the commit feed, commit failure, blobs, limits, and health and identity; a backend's tests give it a harness and call `runStorageConformance` ([`conformance/index.ts`](../../../packages/storage/src/conformance/index.ts)). The memory backend and `postgres` both run it ([`memory-conformance.test.ts`](../../../packages/storage/tests/memory-conformance.test.ts), [`conformance.test.ts`](../../../bundles/foundation/postgres/tests/conformance.test.ts)).

Only storage backends and the core's host part import it; every other bundle reaches storage through `storage/v1` ([`postgres/package.json`](../../../bundles/foundation/postgres/package.json), [`core/src/host/storage/facade.ts`](../../../bundles/foundation/core/src/host/storage/facade.ts)).

## A Thread's history

The history of a Thread is split by owner:

| Part                                             | Owner and where it is kept                                                                                                                                                                                                                                                                                                                         |
| ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The authoritative event log                      | `runtime`: the stream `runtime.thread.events/<threadId>`, whose entries are `{ projectId, threadId, promptId, type, event }` ([`runtime/src/contracts/storage.ts`](../../../bundles/runtime/runtime/src/contracts/storage.ts))                                                                                                                     |
| The Thread's state, queue and usage              | `runtime`: the `runtime.thread/v1` document, whose `lastSequence` equals the stream's counter ([`runtime/src/contracts/storage.ts`](../../../bundles/runtime/runtime/src/contracts/storage.ts))                                                                                                                                                    |
| The provider-ready messages and turn boundaries  | the executor, as opaque parts that `runtime` stores in `runtime.history/v1` documents with a `format`; the `default` executor writes `default.history/v1` ([`runtime/src/contracts/storage.ts`](../../../bundles/runtime/runtime/src/contracts/storage.ts), [`default/src/host/history.ts`](../../../bundles/runtime/default/src/host/history.ts)) |
| A local snapshot for opening a conversation fast | `history`, on the desktop: disposable, never a source of truth                                                                                                                                                                                                                                                                                     |

A rewind is one commit: it expects the Thread document's revision, truncates the Thread's stream after the last surviving event, appends a `history.truncated` event `{ type, afterSequence }`, writes the executor's rewritten history parts and puts the Thread document with its new counter and the usage of the surviving events ([`store/threads.ts`](../../../bundles/runtime/runtime/src/host/store/threads.ts), [`store/documents.ts`](../../../bundles/runtime/runtime/src/host/store/documents.ts)). A reader that holds removed entries learns it from the truncation marks of its next `read`. [Events and nodes](events-and-nodes.md) describes the events themselves and how a client replays them; the [runtime README](../../../bundles/runtime/runtime/README.md#data-and-storage) gives the full shape of every runtime record.

### The local snapshot

The `history` bundle, in the desktop's main process, provides `history.snapshots/v1`: a best-effort snapshot of each Thread's event log, one JSON file per Thread, so a conversation renders at once when it opens and the event stream reconciles it afterwards ([`history/src/desktop/index.ts`](../../../bundles/desktop/history/src/desktop/index.ts), [`store.ts`](../../../bundles/desktop/history/src/desktop/store.ts)). The files live under the bundle's `doric.cache/v1` directory, at `<hostId>/<storageGeneration>/<threadId>.json`, with the identity read from the `storage` field of `doric.catalog/v1`; a different database or another storage generation therefore never shows another history, and without an identity the store is disabled. When merging, the store drops held events that a `history.truncated` event discarded. Pending writes are flushed in `onBeforeQuitHook` and on deactivation. The [history README](../../../bundles/desktop/history/README.md) gives the contract, the merge rule and the limits.

`doric.cache/v1` is a platform contract of the desktop's main process; a bundle lists it nowhere in its manifest. Its shape is one method ([`platform.ts`](../../../packages/bundle/src/contracts/platform.ts)):

```ts
interface DoricCache {
  /** Absolute cache directory of the calling bundle. */
  directory(call?: CallArg): Promise<string>;
}
```

The desktop answers `<userData>/bundle-cache/<bundleId>`, creating it when it is missing; a caller id that is not a bundle id is `invalid_input` ([`native/cache.ts`](../../../app/desktop/doric/src/platform/native/cache.ts), [`paths.ts`](../../../app/desktop/doric/src/platform/paths.ts)).

## Related documents

- [Core](core.md): the foundation, activation order, recovery mode and `doric.catalog/v1`.
- [Contracts](contracts.md): the `define*` family, `defineStorageType` among it.
- [Manifest](manifest.md): `provides`, `requires` and `providers`.
- [Boundaries](boundaries.md): what a bundle may import, and why only backends import `storage`.
- [Events and nodes](events-and-nodes.md): the durable events written to the streams.
- [Process isolation](process-isolation.md): why a commit is one declarative batch that crosses process boundaries.
- [postgres README](../../../bundles/foundation/postgres/README.md), [core README](../../../bundles/foundation/core/README.md), [storage README](../../../packages/storage/README.md), [runtime README](../../../bundles/runtime/runtime/README.md), [history README](../../../bundles/desktop/history/README.md) and [host README](../../../app/backend/doric-host/README.md#database).
