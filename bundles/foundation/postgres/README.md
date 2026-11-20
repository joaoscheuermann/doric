# Postgres bundle

`postgres` keeps Doric's data in a PostgreSQL database you run: the documents,
streams, commit feed and blobs every bundle stores through `storage/v1`, and
the named credentials, whose secrets are encrypted at rest. It is a foundation
bundle of the Doric host: it provides the two backend contracts on which the
core builds `storage/v1` and `secrets/v1`, and nothing else.

See the [main README](../../../README.md) for Doric as a whole,
[`packages/bundle`](../../../packages/bundle/README.md) for how bundles work,
[the storage architecture](../../../docs/architecture/bundles/storage.md) for
how the core and the other bundles use storage, and
[`packages/storage`](../../../packages/storage/README.md) for the helpers and
the conformance kit every storage backend shares.

## Manifest

[`manifest.json`](manifest.json):

| Field             | Value                                                  |
| ----------------- | ------------------------------------------------------ |
| `manifestVersion` | `1`                                                    |
| `id`              | `postgres`                                             |
| `version`         | `2.0.0`                                                |
| `engines.doric`   | `^1.0.0`                                               |
| `description`     | `PostgreSQL storage and secrets backends over Prisma.` |
| `provides`        | `storage.backend/v1@1.1.0`, `secrets.backend/v1@1.0.0` |
| `requires`        | none                                                   |
| `optional`        | none (the field is absent)                             |

The bundle has one part, the host part ([`src/host/index.ts`](src/host/index.ts)).
It declares no slot, no contracts module (`src/contracts/` does not exist) and
no contract of its own: both contracts it provides are declared in
[`bundle/contracts`](../../../packages/bundle/src/contracts/basic/storage.ts).
The build writes the descriptor `dist/contracts.json`, where both contracts are
`service` contracts of the `host` environment with cardinality `one`, not
`local`, with their JSON schemas under `dist/schemas/`.

A host composition makes it the foundation by choosing it in `providers` for
both contracts; the Doric host does so in
[`composition.json`](../../../app/backend/doric-host/composition.json)
(`"storage.backend/v1": "postgres"`, `"secrets.backend/v1": "postgres"`). A
foundation bundle activates before the core, so `postgres` uses only `doric.*`
contracts, which need no declaration.

### Package

[`package.json`](package.json) names the package `postgres` (version `0.0.1`,
private, ES module) and exports only `./package.json` and `./testing`
([Testing entry](#testing-entry)). Its dependencies are `@prisma/adapter-pg`
and `@prisma/client` (both `7.9.1`), `bundle`, `storage` and `tslib`; its
development dependencies are `prisma` (`7.9.1`), `pg` and `@types/pg`.

## Contracts it uses

| Contract           | Used for                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `doric.startup/v1` | `storage.backend/v1.connect` sets the host's startup stage `database_client` with `stage(name)` and writes two `info` lines with `log(record)` around the connection ([`start.ts`](src/host/start.ts)). The contract's shape is in [`platform.ts`](../../../packages/bundle/src/contracts/platform.ts); how start steps use it is in [hooks](../../../docs/architecture/bundles/hooks.md) and [observability](../../../docs/architecture/bundles/observability.md). |

The bundle provides `storage.backend/v1` and `secrets.backend/v1` during
`activate` with `services.provide` ([`postgres.ts`](src/host/postgres.ts)).

## `storage.backend/v1` (version 1.1.0)

The generic storage primitives on PostgreSQL tables
([`storage/backend.ts`](src/host/storage/backend.ts)). The contract's shapes
and the reference `StorageBackendV1` are in
[`packages/bundle/src/contracts/basic/storage.ts`](../../../packages/bundle/src/contracts/basic/storage.ts);
each method's input and output are validated against the schemas of
`storageBackendMethods`. Every method takes an optional last argument, the
call (`CallArg`). Every method except `capabilities` and `health` runs on the
process's one Prisma client ([Client and connection](#client-and-connection)).

### Shapes

Every object is strict: an unknown property fails validation. `int` is an
integer, `uuid` a UUID string.

```ts
type DocumentKey = { type: string; id: string };
type IndexValue = string | number | boolean | null;

type StoredDocument = {
  type: string;
  id: string;
  revision: int;
  value: unknown;
};

type StorageDeclaration = {
  type: string;
  indexes: { name: string; fields: string[]; unique?: boolean }[];
};

type StorageQuery = {
  type: string;
  index: string;
  equals: IndexValue[];
  range?: {
    gt?: IndexValue;
    gte?: IndexValue;
    lt?: IndexValue;
    lte?: IndexValue;
  };
  order?: 'asc' | 'desc'; // 'asc' when absent
  limit: int; // 1..1000
  cursor?: string;
};
type StoragePage = { items: StoredDocument[]; cursor?: string };

type StreamRead = {
  stream: string;
  afterSequence: int /* >= 0 */;
  limit: int; /* > 0 */
};
type StreamEntry = {
  sequence: int /* > 0 */;
  value: unknown;
  createdAt: string;
};
type TruncationMark = { afterSequence: int; atSequence: int };
type StreamPage = {
  entries: StreamEntry[];
  lastSequence: int;
  truncations: TruncationMark[];
};

type CommitBatch = {
  expect?: (DocumentKey & { revision: int /* >= 0; 0 = must not exist */ })[];
  put?: (DocumentKey & { value: unknown })[];
  delete?: DocumentKey[];
  truncate?: { stream: string; afterSequence: int };
  append?: {
    stream: string;
    expectedSequence?: int;
    events: unknown[]; /* >= 1 */
  }[];
  dropStreams?: string[];
};

type FeedRequest = { after: int; limit: int /* > 0 */ };
type FeedPage = {
  commits: {
    position: int;
    documents: DocumentKey[];
    streams: string[]; // appended to
    truncated: string[];
    dropped: string[];
  }[];
};

type StorageCapabilities = {
  maxBatch: int;
  maxDocumentBytes: int;
  maxAppendBytes: int;
};
type StorageHealth = {
  status: 'ok' | 'unavailable';
  writable: boolean;
  reason?: string;
  disk?: { blocks: int; availableBlocks: int };
};
type StorageIdentity = { hostId: uuid; storageGeneration: int /* > 0 */ };
```

A declared index field is a dotted path into the document value (`a.b` reads
`value.a.b`). A stream entry's `createdAt` is ISO-8601 in UTC with
milliseconds.

### Methods

| Method                     | Input                | Output                        |
| -------------------------- | -------------------- | ----------------------------- |
| `declareType(declaration)` | `StorageDeclaration` | `void`                        |
| `get(key)`                 | document key         | `StoredDocument \| undefined` |
| `query(query)`             | `StorageQuery`       | `StoragePage`                 |
| `read(request)`            | `StreamRead`         | `StreamPage`                  |
| `commit(batch)`            | `CommitBatch`        | `{ position: number }`        |
| `feed(request)`            | `{ after, limit }`   | `FeedPage`                    |
| `putBlob(bytes)`           | base64 string        | `{ hash: string }`            |
| `getBlob(hash)`            | `sha256:<hex>`       | base64 string \| `undefined`  |
| `deleteBlob(hash)` (1.1.0) | `sha256:<hex>`       | `void`                        |
| `capabilities()`           | none                 | `StorageCapabilities`         |
| `health()`                 | none                 | `StorageHealth`               |
| `identity()`               | none                 | `StorageIdentity`             |
| `connect()`                | none                 | `void`                        |

`(1.1.0)` marks the one method a caller needs version 1.1.0 of the contract
for; the bundle provides 1.1.0, so it has every method above.

- **`declareType`** ([`declare.ts`](src/host/storage/declare.ts)) records a
  type's indexes in `storage_type`. An index name given twice is
  `invalid_input`. A declaration equal to the stored one changes nothing:
  equal means the same indexes in the same order, each with the same name,
  the same fields in the same order and the same `unique`, an absent `unique`
  read as `false`; reordering the indexes counts as a change. A
  changed one replaces the stored declaration and rebuilds the index entries
  of every stored document of the type, in one transaction; a value that
  cannot be indexed (`invalid_index_value`) or a duplicate key of a unique
  index (`unique_conflict`) leaves the previous declaration and its entries
  as they were. Documents are never deleted by a declaration.
- **`get`** ([`query.ts`](src/host/storage/query.ts)) returns the document as
  stored, or `undefined`.
- **`query`** ([`query.ts`](src/host/storage/query.ts)) reads one page of a
  declared index. An undeclared index is `invalid_input`. `equals` takes the
  leading fields of the index and `range` the next one: more `equals` values
  than fields, or a `range` with no field left, is `invalid_input`, and so is
  a range with both `gt` and `gte` or both `lt` and `lte`. Items are ordered
  by index key and then by document id, both bytewise, ascending or as
  `order` says. When more items follow, the page carries a `cursor`, an
  opaque base64url string that only this backend reads: it holds the last
  item's index key and document id, and the next page resumes strictly after
  that pair in the requested order. A malformed cursor is `invalid_input`.
  Values come back as stored, without validation.
- **`read`** ([`streams.ts`](src/host/storage/streams.ts)) returns, from one
  statement and so one snapshot, at most `limit` entries with a sequence above
  `afterSequence` in sequence order, the stream's `lastSequence`, and, in
  position order, the truncation marks whose `afterSequence` is below the
  request's `afterSequence` and whose `atSequence` is at or above it: the
  truncations that removed entries this reader may hold. An
  absent stream is at 0. Reading after `lastSequence` is `invalid_input`, with
  details `{ stream, afterSequence, lastSequence }`.
- **`commit`** ([`commit.ts`](src/host/storage/commit.ts)) applies one batch
  atomically, as described under [Commits](#commits), and returns the commit's
  feed position.
- **`feed`** ([`feed.ts`](src/host/storage/feed.ts)) returns at most `limit`
  commits with a position above `after`, in position order. Positions start
  at 1 and have no gaps. A commit lists the unique document keys it deleted
  or put, the streams it appended to, the stream it truncated and the streams
  it dropped.
- **`putBlob`** ([`blobs.ts`](src/host/storage/blobs.ts)) takes canonical
  base64 (whole four-character groups, padding only at the end; anything else
  is `invalid_input`), stores the bytes once under `sha256:<lowercase hex>`
  of the bytes and returns that hash. Storing the same bytes again changes
  nothing.
- **`getBlob`** returns the bytes as base64, or `undefined` for an unknown
  hash or one that is not `sha256:` followed by 64 lowercase hex digits.
- **`deleteBlob`** removes the blob; an unknown or malformed hash does
  nothing.
- **`capabilities`** returns the limits ([Limits](#limits)).
- **`health`** ([`health.ts`](src/host/storage/health.ts)) measures the
  filesystem at `DORIC_STORAGE_PATH` (the current directory when unset), read
  when the check runs, with `statfs`. It makes no database round trip, so a
  database outage is never reported as low storage. A measured disk answers
  `{ status: 'ok', writable: true, disk: { blocks, availableBlocks } }`, with
  `availableBlocks` the blocks available to an unprivileged process; a
  failed measurement answers `status: 'unavailable'`, `writable: false` and
  `reason: 'storage_unmeasurable'`, with no `disk`. The low-storage policy
  belongs to the caller.
- **`identity`** ([`identity.ts`](src/host/storage/identity.ts)) returns the
  `identity` record of `storage_meta`. The first call over a database creates
  it with a random `hostId` (`gen_random_uuid()`) and `storageGeneration` 1;
  every later call, from this or any other instance over the same database,
  returns the same record.
- **`connect`** ([`start.ts`](src/host/start.ts),
  [`database.ts`](src/host/database.ts)) opens the process's connection once
  at the host's start: the core's start step calls it before it reads the
  stored credentials. It sets the startup stage `database_client`, logs
  `Initializing PostgreSQL client`, creates and connects the client, checks
  the database ([Client and connection](#client-and-connection)) and logs
  `PostgreSQL client initialized`. A rejection fails the host's start at that
  stage.

### Commits

A commit runs in one interactive transaction (up to 30 s to start and 120 s
to finish) and applies its parts in the order expect → delete → put →
dropStreams → truncate → append, or none of them. A failed batch leaves no
document, index entry, stream entry, truncation mark or feed entry behind, and
takes no position.

1. **Limits.** Before anything is sent, a batch with no item is
   `invalid_input`, and a batch over `maxBatch` items, a put value over
   `maxDocumentBytes` or an appended event over `maxAppendBytes` is
   `limit_exceeded` with details `{ what, limit }`, where `what` is `batch`,
   `document` or `append`. A batch's items are its `expect`, `put`, `delete` and
   `dropStreams` entries, its `truncate` (one) and every appended event; sizes
   are the UTF-8 bytes of the JSON text.
2. **Locks.** The commit takes every lock it needs at once, as
   transaction-scoped PostgreSQL advisory locks in one global order (by the
   lock's 64-bit hash), so two commits never wait on each other in a cycle: an
   exclusive lock per document it expects, deletes or puts, a shared lock per
   type it writes (`declareType` takes the same lock exclusively), and an
   exclusive lock per stream it drops, truncates or appends to.
3. **Clock.** It reads the database clock once, truncated to milliseconds;
   every timestamp the commit writes is that instant.
4. **expect.** Each entry's stored revision (0 when absent) must equal its
   `revision`, or the batch fails with `revision_conflict`, details
   `{ type, id, expected, actual }`.
5. **delete.** Removes the documents and their index entries; an absent
   document is ignored.
6. **put.** In batch order, one at a time: inserts the document at revision 1
   or raises its revision by 1, replaces its value and `updated_at`, and
   replaces its index entries under the type's current declaration (a type
   with no declaration has none). An `undefined` value is stored as `null`.
   A field that holds an object or an array is
   `invalid_index_value`; a key a unique index already holds for another
   document is `unique_conflict`, details `{ type, index }`, checked at each
   put.
7. **dropStreams.** Removes each stream with its entries and truncation marks.
8. **truncate.** Removes the entries above `afterSequence`; the stream's
   counter does not change. A stream that does not exist is created at 0.
   `afterSequence` above the counter is `invalid_input`, details
   `{ stream, afterSequence, lastSequence }`.
9. **append.** Creates an absent stream at 0. An entry whose
   `expectedSequence` is given and differs from the counter is
   `sequence_conflict`, details `{ stream, expected, actual }`. Each event gets
   the next sequence, and an `undefined` event is stored as `null`; the
   counter never decreases, so a truncated sequence is never reused.
10. **Position.** Last, under one global advisory lock held until the commit
    ends, the commit takes position `max(position) + 1` and records its feed
    entry, so positions become visible in commit order and the feed never shows
    a gap that fills in later. A truncation also records its mark
    `{ afterSequence, atSequence }` under that position, with `atSequence` the
    counter at the end of the batch, appends of the same batch included.

### Index keys

An index key is the order-preserving byte encoding of the values the index
fields hold, from `encodeIndexKey` and `indexValues` of
[`storage`](../../../packages/storage/README.md): a missing field is `null`,
the order across kinds is `null < false < true < numbers < strings`, numbers
compare numerically and strings bytewise in UTF-8, and a tuple's encoding is a
prefix of every longer tuple that starts with it. A query selects the key
range `[lower, upper)` that `keyBounds` computes from `equals` and `range`.

### Limits

[`backend.ts`](src/host/storage/backend.ts) takes `defaultStorageCapabilities`
of `storage`, overridden by the `limits` option of `createPostgres`:

| Capability         | Default      |
| ------------------ | ------------ |
| `maxBatch`         | 10 000 items |
| `maxDocumentBytes` | 268 435 455  |
| `maxAppendBytes`   | 268 435 455  |

A query page holds at most 1000 items (the contract's schema).

## `secrets.backend/v1` (version 1.0.0)

Credentials in the `credential` table
([`secrets/backend.ts`](src/host/secrets/backend.ts),
[`secrets/table.ts`](src/host/secrets/table.ts)). The contract's shapes and
the reference `SecretsBackendV1` are in
[`packages/bundle/src/contracts/basic/secrets.ts`](../../../packages/bundle/src/contracts/basic/secrets.ts).
Secrets cross the contract in plaintext and are encrypted only inside this
backend. Which kinds exist, which fields a kind requires, which credentials
are referenced and who may resolve them belong to `secrets/v1` of the core,
which calls this backend.

```ts
type StoredSecret = {
  id: string;
  kind: string; // matches ^[A-Z][A-Z0-9_]{1,31}$
  name: string;
  username?: string;
  email?: string;
  secret?: string; // plaintext
  createdAt?: string; // ISO-8601
  updatedAt?: string; // ISO-8601
};
```

| Method        | Input          | Output                      |
| ------------- | -------------- | --------------------------- |
| `list()`      | none           | `StoredSecret[]`            |
| `get(id)`     | string         | `StoredSecret \| undefined` |
| `put(record)` | `StoredSecret` | `void`                      |
| `delete(id)`  | string         | `'deleted' \| 'missing'`    |

`StoredSecret` is strict: an unknown property fails validation.

- **`list`** returns every row ordered by `name` ascending, in the
  database's default collation for `text`, not bytewise.
- **`get`** returns the row with that id, or `undefined`. The `id` column is
  a `uuid`, and only a missing row is mapped: an id that is not a UUID
  rejects with the database error, as the driver reports it.
- Both return the row with its secret decrypted: a `NULL` column is absent
  from the record, an empty stored secret is `''`, and `createdAt` and
  `updatedAt` are always set. Without a key, a read that would return a
  non-empty stored secret fails with `credential_key_required`, with the
  message "DORIC_CREDENTIAL_KEY is required while a stored credential holds a
  secret." (`list` fails when any row holds one). A secret that is not a
  supported envelope, or that the cipher rejects, fails with `credential_unreadable` and the cause's
  message: an unreadable row is an error, never an empty secret.
- **`put`** upserts by `id`. A new row takes `id`, `kind`, `name`,
  `username`, `email` and `secret`; an update sets `name`, `username`,
  `email` and `secret` and never changes `kind`. The record's `createdAt` and
  `updatedAt` are ignored: `created_at` is the time of the insert and
  `updated_at` the time of each write. An absent field is stored as `NULL`.
  An absent `secret` needs no key; any present one, `''` included, needs it,
  or the call fails with
  `credential_storage_unavailable`, with the message "DORIC_CREDENTIAL_KEY is
  required to store a credential secret." A name another row of the same kind
  holds fails with `credential_name_taken`, with the message "A <kind>
  credential named "<name>" is already stored."
- **`delete`** removes the row and answers `deleted`, or `missing` when no row
  has the id; an id that is not a UUID rejects with the database error, as the
  driver reports it.
  `delete` never reads the key.

### Encryption

[`secrets/envelope.ts`](src/host/secrets/envelope.ts) seals each secret with
AES-256-GCM under `DORIC_CREDENTIAL_KEY`, which must be exactly 32 bytes in
base64 (43 characters and one `=`, surrounding whitespace ignored). A
non-empty secret is stored as the envelope `v1:<nonce>:<tag>:<ciphertext>`:
a random 12-byte nonce, the 16-byte authentication tag and the UTF-8
ciphertext, each in base64. The empty secret is stored as `''`, without
encryption. Reading accepts only the `v1` prefix.

The cipher is built at the first `list`, `get` or `put`, and kept. An unset or
blank key builds none (see the reads and `put` above). A key of any other form
fails every `list`, `get` and `put`, before the database is reached, with a
plain `Error` (not a `ContractError`) whose message is "DORIC_CREDENTIAL_KEY
must be 32 base64-encoded bytes.", and the next call reads the key again.

## Client and connection

[`src/prisma.ts`](src/prisma.ts) creates the client: a `PrismaClient` of the
generated client over `@prisma/adapter-pg`, PostgreSQL's native connection
pool, from a connection string. A blank string fails with
`DORIC_DATABASE_URL is required.`

[`database.ts`](src/host/database.ts) keeps the process's one client:

- Nothing is opened at activation, so the build's dry activation and a host
  start without a database URL activate the bundle. The client is created on
  the first call that needs it, from `DORIC_DATABASE_URL`; a missing URL
  rejects that call, is not remembered, and fails the next call the same
  way.
- `connect` connects the client and then checks the database: when the
  tables `project`, `thread` and `thread_event` all exist and one of them
  holds a row, it fails with the message "Legacy Project and Thread data has
  not been migrated; run prisma migrate deploy." When the database cannot
  answer that check, the check passes, and the first query that needs the
  database fails instead.
- The bundle's deactivation disconnects the client when the bundle created it
  from the URL; an injected client is left to its owner.

The storage methods use raw SQL on the storage tables; the secrets backend
uses the `credential` model of the client.

## Data and persistence

### Prisma setup

- [`prisma/schema.prisma`](prisma/schema.prisma) holds the models, with the
  `prisma-client` generator writing to `src/generated/prisma` and the
  `postgresql` datasource.
- [`prisma.config.ts`](prisma.config.ts) points the Prisma CLI at that schema
  and at `prisma/migrations`, with the datasource URL from
  `DORIC_DATABASE_URL`, or `postgresql://doric:doric@127.0.0.1:5432/doric`
  when it is unset. Only the CLI reads it (`prisma-generate`, `migrate`).
- `src/generated/prisma` is the generated client. It is not tracked
  ([`src/generated/.gitignore`](src/generated/.gitignore)); the
  `prisma-generate` target writes it and the build compiles it into
  `dist/generated`.
- [`prisma/migrations`](prisma/migrations) holds the migrations, one
  `migration.sql` per directory, applied in name order;
  [`migration_lock.toml`](prisma/migrations/migration_lock.toml) names the
  `postgresql` provider. No table name in them is schema-qualified.

### Schema

The migrations under [`prisma/migrations`](prisma/migrations) leave these
tables, which the models of [`prisma/schema.prisma`](prisma/schema.prisma)
mirror. The storage tables hold what Prisma cannot express in the schema
file: `COLLATE "C"` on the key columns, so text compares bytewise, the
partial unique index of unique index entries, and the positive revision
check.

| Table                  | Columns                                                                                                                                                                                         | Keys and constraints                                                                                                                                                                    |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `credential`           | `id uuid`, `kind text`, `name text`, `username text?`, `email text?`, `secret text?` (the envelope), `created_at timestamptz(3)`, `updated_at timestamptz(3)` (set by the client at each write) | primary key `id`; unique `(kind, name)`                                                                                                                                                 |
| `storage_meta`         | `key text`, `value jsonb`                                                                                                                                                                       | primary key `key`                                                                                                                                                                       |
| `storage_type`         | `type text C`, `indexes jsonb` (`{ name, fields, unique }[]`), `declared_at timestamptz(3)`                                                                                                     | primary key `type`                                                                                                                                                                      |
| `storage_document`     | `type text C`, `id text C`, `revision integer`, `value jsonb`, `updated_at timestamptz(3)`                                                                                                      | primary key `(type, id)`; check `revision > 0`                                                                                                                                          |
| `storage_index_entry`  | `type text C`, `index_name text C`, `key bytea`, `document_id text C`, `unique_key boolean`                                                                                                     | primary key `(type, index_name, key, document_id)`; unique `(type, index_name, key) WHERE unique_key`; index `(type, document_id)`; `(type, document_id)` references `storage_document` |
| `storage_stream`       | `stream text C`, `last_sequence integer` (default 0)                                                                                                                                            | primary key `stream`                                                                                                                                                                    |
| `storage_stream_entry` | `stream text C`, `sequence integer`, `value jsonb`, `created_at timestamptz(3)`                                                                                                                 | primary key `(stream, sequence)`; `stream` references `storage_stream`                                                                                                                  |
| `storage_commit`       | `position bigint`, `documents jsonb`, `streams jsonb`, `truncated jsonb` (default `[]`), `dropped jsonb` (default `[]`), `committed_at timestamptz(3)`                                          | primary key `position`                                                                                                                                                                  |
| `storage_truncation`   | `stream text C`, `position bigint`, `after_sequence integer`, `at_sequence integer`                                                                                                             | primary key `(stream, position)`; `stream` references `storage_stream`; `position` references `storage_commit`                                                                          |
| `storage_blob`         | `hash text`, `bytes bytea`, `size integer`, `created_at timestamptz(3)`                                                                                                                         | primary key `hash`                                                                                                                                                                      |

`text C` is `text COLLATE "C"`; `?` marks a nullable column; every other
column is `NOT NULL`, and every `timestamptz(3)` column except
`credential.updated_at` defaults to the current time. Every foreign key of the
storage tables is `ON UPDATE CASCADE`; each is `ON DELETE CASCADE` except
`storage_truncation.position`, which is `ON DELETE RESTRICT`. `credential.id`
has no database default, so `put` must give a UUID; any other id rejects
with the database error, as the driver reports it.

### Rows the migrations leave

`prisma migrate deploy` over an empty database leaves these rows; over a
database that already holds data, the same records hold that data instead of
the defaults.

- `credential`: one row, id `00000000-0000-4000-8000-000000000002`, kind
  `API_TOKEN`, name `OPENROUTER_API_KEY`, secret `''`, no `username` or
  `email`.
- `storage_document` `core.settings/v1` / `host-config.configuration/v1`, at
  revision 2, with the value
  `{ version: '1.0.0', updatedAt, generation: 2, value }`, where `value` is
  the default configuration:

  ```json
  {
    "providers": [
      {
        "id": "openrouter",
        "kind": "openrouter",
        "configuration": {
          "endpoint": "https://openrouter.ai/api/v1",
          "token": "00000000-0000-4000-8000-000000000002"
        },
        "models": []
      }
    ],
    "models": {
      "execution": {
        "providerId": "openrouter",
        "model": "deepseek/deepseek-v4-flash-0731",
        "effort": "low"
      }
    },
    "execution": { "maxTurns": 32 },
    "tools": {}
  }
  ```

- `storage_document` `core.settings-generation/v1` / `global`, at revision 1,
  with the value `{ generation: 2 }`, equal to the configuration's revision.
- `storage_document` `runtime.migration/v1` / `legacy-prisma`, at revision 1,
  with the value `{ source: 'prisma-legacy', completedAt, counts }`, where
  `counts` is `{ projects, threads, events, histories }`, all 0 on an empty
  database. Over a database with Projects and Threads, the migrations also
  leave their `runtime.project/v1`, `runtime.thread/v1` and
  `runtime.history/v1` documents and their `runtime.thread.events/<threadId>`
  streams.
- `storage_commit`: position 1 names the two settings documents and position
  2 names `runtime.migration/v1` / `legacy-prisma`, so the first commit of
  the backend takes position 3.
- `storage_meta` `coalesced-thread-deltas`, with the fields `completedAt`,
  `entriesBefore`, `entriesAfter`, `coalesced`, `absorbed`, `droppedEmpty` and
  `storageGeneration`. It is always written, and its presence marks the
  delta-merging migration as applied, so applying it again changes nothing.
  On an empty database the counts are 0 and `storageGeneration` is `null`.

`completedAt` and `updatedAt` are ISO-8601 in UTC with milliseconds.

### Reserved records of `storage_meta`

- `identity`: `{ hostId, storageGeneration }`, written by the first
  `identity` call ([`identity.ts`](src/host/storage/identity.ts)). The
  migration that merges the delta entries of `runtime.thread.events/<threadId>`
  streams raises its `storageGeneration` by 1 when it changes an entry.
- `coalesced-thread-deltas`: see [Rows the migrations leave](#rows-the-migrations-leave).

## Side effects

- **Network**: connections to the PostgreSQL server of `DORIC_DATABASE_URL`,
  through the client's pool, from the first call that needs the database
  ([`database.ts`](src/host/database.ts)).
- **Filesystem**: `statfs` on `DORIC_STORAGE_PATH` at each `health` call;
  nothing is written ([`health.ts`](src/host/storage/health.ts)).
- **Host startup**: the stage `database_client` and two `info` log lines
  during `connect` ([`start.ts`](src/host/start.ts)).
- No events are emitted and no process is started.

## Configuration

| Variable               | Read                                                        | Purpose                                                                           |
| ---------------------- | ----------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `DORIC_DATABASE_URL`   | at the first call that needs the database                   | The PostgreSQL connection string of the client; also the Prisma CLI's datasource. |
| `DORIC_CREDENTIAL_KEY` | at the first `list`, `get` or `put` of `secrets.backend/v1` | The base64 AES-256 key that seals and opens stored secrets.                       |
| `DORIC_STORAGE_PATH`   | at each `health` call                                       | The filesystem `health` measures; the current directory when unset.               |

`PostgresOptions` ([`options.ts`](src/host/options.ts)) changes where and how
these are taken, for tests:

- `environment`: the variables' source instead of `process.env`;
- `database`: a function that builds the client instead of the URL; the
  bundle then never disconnects it;
- `statfs`: `(path) => Promise<DiskMeasurement>`, the filesystem measurement
  instead of `statfs(path, { bigint: true })` of `node:fs`, where
  `DiskMeasurement` is `{ blocks: bigint; bavail: bigint }`;
- `limits`: overrides of the storage capabilities.

## Errors and failure behavior

- Contract errors are `ContractError`s with the codes above:
  `invalid_input`, `limit_exceeded`, `revision_conflict`, `sequence_conflict`,
  `unique_conflict` and `invalid_index_value` from `storage.backend/v1`
  ([`storage/`](src/host/storage/)), and `credential_key_required`,
  `credential_storage_unavailable`, `credential_unreadable` and
  `credential_name_taken` from `secrets.backend/v1`
  ([`secrets/backend.ts`](src/host/secrets/backend.ts)).
- A malformed `DORIC_CREDENTIAL_KEY` fails `list`, `get` and `put` with a
  plain `Error`, "DORIC_CREDENTIAL_KEY must be 32 base64-encoded bytes."
  ([`envelope.ts`](src/host/secrets/envelope.ts)).
- A missing database URL rejects every database call with a plain `Error`,
  "DORIC_DATABASE_URL is required." ([`prisma.ts`](src/prisma.ts),
  [`database.ts`](src/host/database.ts)); `health` and `capabilities` still
  answer.
- Any other database failure (an unreachable server, a full disk, an id that
  is not a UUID) rejects the call with the database error, as the driver
  reports it, and a failed
  commit or declaration rolls back.
- Running `prisma migrate deploy` stops with an error, and leaves those tables
  as they are, while `project`, `thread` or `thread_event` hold a row; the
  [host README](../../../app/backend/doric-host/README.md#database) gives the
  operator's steps for the database.

## Testing entry

`postgres/testing` ([`src/testing.ts`](src/testing.ts)), for tests only:

- `createPostgres(options?)` returns `{ storage, secrets, close() }`: the two
  service definitions over one lazily created client, and the close that
  disconnects a client created from the URL.
- `postgresEmbedded(options?)` returns the bundle as an embedded bundle (id
  `postgres` unless `options.id` is given), for tests that boot a host over
  PostgreSQL without staging the bundle; the composition must still choose it
  in `providers` for both backends. Its manifest and descriptor declare
  version `1.0.0` and provide `storage.backend/v1@1.0.0` and
  `secrets.backend/v1@1.0.0`, with the same descriptor fields as
  `dist/contracts.json` ([`postgres.ts`](src/host/postgres.ts)).
- `PrismaClient` and the type `Database`, so a test can seed or read the
  database directly; the types `PostgresOptions` and `DiskMeasurement`
  (`{ blocks: bigint; bavail: bigint }`).

## Build and test

```console
npx nx run bundle-postgres:prisma-generate
npx nx run bundle-postgres:typecheck
npx nx run bundle-postgres:build
DORIC_TEST_DATABASE_URL=postgresql://... npx nx run bundle-postgres:test
npx nx run bundle-postgres:migrate
```

[`project.json`](project.json) declares:

- `prisma-generate`: `prisma generate`, writing `src/generated/prisma`.
- `typecheck`: `tsc --build --emitDeclarationOnly`, after `prisma-generate`.
- `build`: after `prisma-generate`, `tsc --build` into `dist/`, then the
  bundle build of `packages/bundle`, which writes `dist/manifest.json`,
  `dist/package.json`, `dist/contracts.json` and `dist/schemas/`.
  `doric-host:build-bundles` stages `dist` into
  `app/backend/doric-host/dist/bundles/postgres`.
- `test`: after `build`, compiles `src/` and `tests/` into `dist-tests/` and
  runs `node --test` on `dist-tests/tests/*.test.js`; it is never cached.
- `migrate`: `prisma migrate deploy` against `DORIC_DATABASE_URL`.

The suites that need PostgreSQL skip without `DORIC_TEST_DATABASE_URL`; each
creates its own schema there, applies every `migration.sql` in name order, and
drops the schema at the end ([`tests/support/database.ts`](tests/support/database.ts)).
The size report of `coalesce-deltas-size.test.ts` also needs
`DORIC_TEST_COALESCE_SIZE=1`. The suites:

- `conformance.test.ts` runs the conformance kit of `storage/conformance`
  against `storage.backend/v1`;
- `storage-documents`, `storage-queries`, `storage-streams` and
  `storage-feed` cover documents and commits, index queries, streams and
  truncation, and the feed;
- `secrets.test.ts` and `secrets-legacy.test.ts` cover the credential table
  and the envelope;
- `health.test.ts` and the first two cases of `activate.test.ts` run without
  a database;
- `migration.test.ts`, `coalesce-deltas.test.ts` and
  `drop-legacy-tables.test.ts` apply the migrations over seeded data and
  check the schema and records they leave.
