# sqlite

The engine bundle `sqlite`: one Nx project, `sqlite`, of two Rust crates, built
on the Rust SDK
[`doric-bundle`](../../../packages/bundle-rs/README.md). It serves the contract
`storage.kv/v1`
([`kv.proto`](../../../packages/bundle/proto/doric/storage/kv/v1/kv.proto),
`doric.storage.kv.v1.KvService` with `Get`, `Range` and `Commit`) over one
SQLite file, through `rusqlite` 0.43.0 with SQLite bundled, and only to the
caller `doric`, the platform. It holds all of storage (A79): the engine
`doric-sqlite` reads no value, and `doric-storage` decodes values with each
bundle's descriptors (`storage/src/schema.rs`), owns the index-key encoding
(`storage/src/keys.rs`) and serves `storage/v2`'s `Register` (S77a2), `Commit` and `Get` (S77a3a), `Query` (S77a3b), `Read` and `Commit`'s stream items (S78a), and `PutBlob`, `GetBlob`, `DeleteBlob` and `Health` (S78b), and `Watch` (S78c). Every write reads document headers and stream heads from SQLite inside the writer's transaction; the cache of A80, which `DORIC_SQLITE_CACHE` turned on or off, was removed by S78d (A84), and `DORIC_SQLITE_CACHE` is no longer read. It is section
17, "The engine", of
[`docs/designs/grpc-processes.md`](../../../docs/designs/grpc-processes.md);
see [`docs/features/bundle-processes.md`](../../../docs/features/bundle-processes.md),
"Phase 4" (slices S74a, S76, S77a1, S77a2, S77a3a, S77a3b, S77a4a, S77a4b, S78a, S78b, S78c and S78d).

- [`engine/`](engine), the library `doric-sqlite`: `SqliteEngine`, the traits
  `KvEngine`, `ReadTxn` and `WriteTxn`, the types `KeyRange` and `Entry`,
  `open`, the constant `DORIC`, and `refusal`, `hex`, `sqlite_version`, `limits` and `kv` (the generated messages).
- [`storage/`](storage), the package `doric-storage`: the binary, still named
  `doric-sqlite`, at `dist/target/doric-sqlite/{debug,release}/doric-sqlite`.
  Its `storage.kv/v1` handlers are in [`storage/src/kv.rs`](storage/src/kv.rs).
  Its library ([`storage/src/lib.rs`](storage/src/lib.rs)) holds `keys`,
  `schema` (with `Pools`, the descriptor-pool cache), `layout` (the key
  builders `document`, `chunk`, `index` and `prefixed`), `register`, `commit`
  (`Batch`, `Items`, `apply`, `Clock`), `documents` (`check`, `get`), `query`
  (`LIMIT`, `Plan`, `check`, `page`), `streams` (`check`, `checked`, `read`),
  `blobs`, `health` and `watch`, and the helper `bundle`;
  [`storage/src/main.rs`](storage/src/main.rs) serves
  `/doric.storage.v2.StorageService/Register`, `/Commit`, `/Get`, `/Query`,
  `/Read`, `/PutBlob`, `/GetBlob`, `/DeleteBlob`, `/Health` and `/Watch`, each
  `unavailable` before activation once the caller and the request pass their
  checks; `storage/src/main/reads.rs` holds `stream_read`, `ANSWERS` and
  `query_documents`, `storage/src/blobs.rs` the blobs and
  `storage/src/health.rs` `Health`, from `statvfs` on `DORIC_STORAGE_PATH`.
  `storage/src/watch.rs` holds `Watch`'s subscribers (a buffer of 1,024 each;
  one that falls behind ends with `unavailable`), published after `COMMIT`, and
  `storage/src/main/watch.rs` its handler (S78c).
- [`proto/doric/storage/layout/v1/layout.proto`](proto/doric/storage/layout/v1/layout.proto),
  package `doric.storage.layout.v1`: `TypeDeclaration`, `IndexDeclaration` and
  `DocumentHeader`, `StreamHead`, `StreamEntryHeader`, `TruncationMark` and
  `BlobHeader`, the engine's own records, generated only for Rust. It is a
  buf module in the root `buf.yaml`, and `buf export` puts it in `dist/proto`.

## The file

The store is `$DORIC_STORAGE_PATH/doric.sqlite3`, beside its `-wal` and `-shm`
files. When `DORIC_STORAGE_PATH` is unset or empty, the directory is the current
directory. The directory must exist; the engine never creates it.

Activation reads only `DORIC_STORAGE_PATH`. `DORIC_SQLITE_CACHE`, which turned
the cache of document headers on or off, is no longer read since S78d (A84).

Format 1 (`PRAGMA user_version = 1`) holds two tables:

- `kv (key BLOB NOT NULL PRIMARY KEY, value BLOB NOT NULL, version INTEGER NOT NULL) WITHOUT ROWID`;
- `kv_position (id INTEGER NOT NULL PRIMARY KEY CHECK (id = 1), position INTEGER NOT NULL)`,
  one row, starting at position 0.

Activation opens the store off the runtime's threads, in this order
([`store.rs`](engine/src/store.rs)):

1. the directory must be a directory, else `storage_path_missing`;
2. the writer connection opens the file read-write, creating it, and reads
   `user_version` before it changes anything; a value other than 0 or 1 is
   `storage_format_unsupported` and the file is left untouched;
3. the writer sets `journal_mode = WAL` (anything but `wal` is `internal`),
   `synchronous = FULL`, `busy_timeout = 5000`, `foreign_keys = OFF`, creates
   the tables and sets `user_version = 1`; each step is idempotent;
4. four read-only connections open with `busy_timeout = 5000`.

It then logs `SQLite <version> is open.` at `info`. A failed activation leaves
the engine without a store. A second `Activate` keeps the first store and closes
the one it opened.

## Structure

- [`storage/src/main.rs`](storage/src/main.rs): the `Bundle` (activation,
  stop) and the `storage/v2` handlers `Register`, `Commit`, `Get`, `Read`,
  `Health`, `PutBlob`, `GetBlob` and `DeleteBlob`; its `Engine` holds the
  clock, the pool cache and the `Watchers`. Its private
  `activate_from(storage_path)` is what `activate` calls with
  `std::env::var_os("DORIC_STORAGE_PATH")`. Its tests are in
  [`storage/src/main/tests.rs`](storage/src/main/tests.rs), declared with
  `#[path]`.
- [`storage/src/main/reads.rs`](storage/src/main/reads.rs): `stream_read`,
  which runs the read of `Get`, `Query`, `Read` and `GetBlob` in one read
  transaction in a spawned task and answers through a channel of 16
  (`ANSWERS`), and `query_documents`, which serves `Query`.
- [`storage/src/main/watch.rs`](storage/src/main/watch.rs): the `Watch`
  handler.
- [`storage/src/kv.rs`](storage/src/kv.rs): the three handlers. Each refuses
  any caller but `doric` with `not_owner`, message
  `storage.kv/v1 serves only the platform.` and no details, before any limit,
  store or I/O, then calls `SqliteEngine`.
- [`storage/src/keys.rs`](storage/src/keys.rs): `Element`, `encode`, `decode`
  and `key`, the index-key encoding, a byte-for-byte port of `encodeIndexKey`
  and `decodeIndexKey` in
  [`packages/storage/src/keys.ts`](../../../packages/storage/src/keys.ts).
  The Rust engine owns this encoding. `Range` and `bounds`, the index range of a
  query, port `keyBounds` (`keys.ts:285-319`).
- [`storage/src/schema.rs`](storage/src/schema.rs): `json_form`, a value in
  protobuf-es's `toJson` form with `alwaysEmitImplicit` (prost-reflect with
  `skip_default_fields(false)`), and `index_values`, the index fields read as
  `indexValues` and `resolvePointer` read them; `Pools`, the cache of 32
  descriptor pools (`POOLS`).
- [`storage/src/schema/declarations.rs`](storage/src/schema/declarations.rs):
  `pool` and `declarations`, which read a descriptor set's `storage_type` and
  `stream_entry` options with prost-reflect. A set over 2 MiB is
  `limit_exceeded`. A type or stream prefix outside the caller's namespace is
  `not_owner`: a type's namespace is everything before its first `.` or `/`, a
  stream prefix's owner everything before its first `.`. `invalid_input`: an
  index field that is not a singular scalar or a well-known value, more than
  16 indexes or more than 8 fields in one, a duplicate index name, a type
  declared twice, an empty or more-than-128-byte id.
- [`storage/src/layout.rs`](storage/src/layout.rs): the record keys
  `("schema", hash)`, `("schema.current")`, `("type", t)` and `under`; the
  document keys `document`, `chunk`, `index` and `prefixed`; `checked`, the
  type's length, namespace and id's length; `ID_BYTES` (512), `CHUNK_BYTES`
  (983,040) and `INDEX_KEY_BYTES` (2,048).
- [`storage/src/commit.rs`](storage/src/commit.rs): `Batch`, which checks each
  `Commit` item as it arrives and `finish`es into `Items`; `apply`, the read
  transaction then the writer's transaction; `Clock` and `iso`, the
  `updatedAt` clock.
- [`storage/src/commit/transaction.rs`](storage/src/commit/transaction.rs):
  `plan`, the index keys computed in the read transaction, and `write`, the
  batch in the writer's transaction (expects, deletes, puts), each header read
  through `documents::stored_header` inside the transaction, which sees the
  transaction's own writes, so no overlay is kept (S78d, A84).
- [`storage/src/commit/streams.rs`](storage/src/commit/streams.rs): the batch's
  stream items in the writer's transaction (drops, truncate, appends), each
  head read through `streams::last_sequence` inside the transaction (S78d).
- [`storage/src/streams.rs`](storage/src/streams.rs): `checked`, a stream id's
  checks; `check` and `read`, `Read`'s checks and read; `last_sequence`, a
  stream's stored head or 0.
- [`storage/src/documents.rs`](storage/src/documents.rs): `check` and `get`, the
  `Get` handler's checks and read, and the `pub(crate)` trait `DocumentItems`
  and `emit_document`, which `Get` and `Query` share to answer a document and
  its chunks.
- [`storage/src/query.rs`](storage/src/query.rs): `check`, the `Query`
  request's checks into a `Plan`, and `page`, one page in one read transaction;
  `LIMIT` (1000); `DocumentItems` for `QueryResponse`; the cursor in `base64`'s
  `URL_SAFE_NO_PAD`.
- [`storage/src/register.rs`](storage/src/register.rs): `prepare` and
  `Registrations::apply`, `Register`. It refuses the caller `doric` with
  `not_owner`, hashes the set with SHA-256 and stores the schema and the
  current one; a set with nothing new is not written. A declaration whose
  `messageType` or `schema` alone changes is rewritten without a rebuild;
  changed indexes on a type that has documents are rebuilt in the same write
  transaction (A81), and `Registrations::apply` returns one `Rebuilt` per
  rebuilt type, which the handler logs at `info` as
  `Rebuilt the indexes of <type>: <n> documents in <ms> ms.`. The highest generation wins, held only in
  the engine's memory, and schemas no longer named are collected.
- [`storage/src/register/backfill.rs`](storage/src/register/backfill.rs):
  `changes` (the indexes to clear, changed or removed, and to build, new or
  changed, in declared order; indexes are compared as whole declarations —
  name, fields and `unique` — and only the ranges are cleared by name, so a
  rename is a removal plus a new index and a change of fields or `unique` under
  one name is a change; a pure reorder rebuilds nothing), `rebuilt` and
  `rebuild`: count the ids keys-only up to `REBUILD_DOCUMENTS` (100,000) plus
  one, clear the changed or removed ranges, walk the documents in key order
  decoding with the pool only when an index needs building, and rewrite each
  header's `index_keys` in declared order, keeping its revision and
  `updated_at`.
- `storage/src/testing.rs` (test support): compiles test protos with protox,
  opens a store in a temporary directory (`open_temp`) and registers the
  documents fixture (`documents_store`), with S77a4a's fixtures `NOTE_BY_TAG`,
  `NOTE_BY_TITLE`, `NOTE_BY_TAG_ON_TITLE`, `NOTE_REORDERED` and
  `documents_set_with_title`.
- [`storage/build.rs`](storage/build.rs): generates the messages of
  `storage/v2` and `layout.proto` with services cleared, keeping the
  `google/protobuf/*` files prost-build needs for `google.protobuf.Value`.
- [`engine/src/access.rs`](engine/src/access.rs): guarantee 8, isolation: a
  caller names only keys under its own prefix, the UTF-8 bytes of
  `<bundleId>/`; `doric` passes any key.
- [`engine/src/limits.rs`](engine/src/limits.rs): the refusals that need no
  connection: the limits, the prefix and the `invalid_input` cases of the
  contract (A76).
- [`engine/src/writer.rs`](engine/src/writer.rs): one dedicated writer thread that owns the
  writer connection and runs one commit at a time, in arrival order, each in a
  `BEGIN IMMEDIATE` transaction, so positions are consecutive. Commits wait in
  a bounded queue of 64. A commit's position is also the version of every key
  it writes; positions stay below 2^53. The writer skips a queued commit whose
  caller has dropped its answer. A `KvEngine` write is also one
  `BEGIN IMMEDIATE` transaction on this thread, so its position stays
  consecutive with the KV commits; its `on_commit` callbacks run after
  `COMMIT`, and a rollback drops them. `foreign_write` tells whether
  `PRAGMA data_version` changed since the writer's last `KvEngine` write; a
  `storage.kv/v1` commit neither reads nor stores it, so it changes neither the
  answer nor what it compares against. Since S78d removed the cache, no caller of
  `doric-storage` reads `foreign_write`; it and the `data_version` tracking are
  kept, unused (S78d's Q1).
- [`engine/src/readers.rs`](engine/src/readers.rs): four read-only connections, each used by one
  blocking task at a time, so reads never wait for the writer and each read is
  a WAL snapshot. `Get` and `Range` answer through bounded channels of 16, so a
  large range is never held in memory. A `KvEngine` read is a
  `BEGIN DEFERRED` snapshot on a reader.
- [`engine/src/store.rs`](engine/src/store.rs): the file, its open and its
  close; [`engine/src/store/foreign.rs`](engine/src/store/foreign.rs) tests
  `foreign_write` across a `storage.kv/v1` commit (E1).
- The engine's unit tests are in
  `engine/src/{writer,store,limits,readers}/tests.rs`, beside their modules,
  and inline in `engine/src/access.rs` (`mod tests`).

Every source file stays under 500 lines, so `schema`, `register` and `commit` are split.
`doric_sqlite::hex` is public.

Stop waits for every commit already queued, runs
`PRAGMA wal_checkpoint(TRUNCATE)`, closes the writer, then waits for the reads
in progress and closes the readers. The `-wal` file is then empty unless the
checkpoint was blocked or failed.

The engine logs at `warn`:

- `The WAL checkpoint was blocked.`;
- `The WAL checkpoint failed: <error>.`;
- `The writer connection did not close: <error>.` (stop goes on);
- `The writer thread did not end cleanly.`

## Errors

### Activation

Activation fails only as the file's open does (`storage_path_missing`,
`storage_format_unsupported`, `internal`, below). The `invalid_input` of
`DORIC_SQLITE_CACHE` is gone with the cache (S78d, A84): the variable is no
longer read.

### `storage.kv/v1`

- `unavailable`: before a successful activation, after stop, or when the
  database stays busy or locked past the busy timeout.
- `not_owner` with no details: any caller but `doric`, checked first (the
  opposite of `storage/v2`, which refuses `doric`). The
  library's prefix check (`engine/src/limits.rs`) never refuses over the
  contract, since `doric` passes every key.
- `limit_exceeded` with `details.limit`, the limit's name (see "Limits").
- `invalid_input`: a `Get` with no keys, a `Range` with `limit` 0 or `start`
  after `end` (`start == end` is an empty range), a commit item with no case
  set, a `clear_range` with `start` after `end`, a commit with no mutation.
- `condition_failed` with `details.key`, in lowercase hexadecimal: the first
  failing condition of a commit, in item order. Nothing is written.
- `storage_path_missing` with `details.path`: a missing directory, or a path
  that is not a directory. `storage_format_unsupported` with
  `details.userVersion`: an unknown format.
- `internal`: a failed activation, a SQLite error during a call other than
  busy or locked, or positions running out.

Every SQLite error maps to a code: busy or locked gives `unavailable`, anything
else gives `internal`.

The checks run in this order, and the first that fails answers; the caller
check comes before all of them:

- `Get`: no keys, then `getKeys`, then the prefix and `keyBytes` of each key.
- `Range`: `limit` 0, `rangeLimit`, `start` after `end`, the prefix of `start`
  then of `end`, `keyBytes`.
- Each commit item: no case, the prefix, `keyBytes` (a positioned put counts
  `key_prefix` plus 8), `valueBytes`, a `clear_range` with `start` after `end`,
  then `commitItems` and `commitBytes`. A positioned put also counts its 8
  bytes toward `commitBytes`.
- At the end of a commit: no mutation.

These refusals run before a transaction opens, so a refused call reads and
writes nothing. `condition_failed` is checked inside the `BEGIN IMMEDIATE`
transaction; every commit error rolls back.

A cancelled call is not a contract code: the SDK ends it with gRPC
`CANCELLED`. A `Commit` whose stream ends early writes nothing; a cancelled
`Commit` writes nothing unless the writer has already begun its transaction. A
cancelled read stops at its next answer.

### `storage/v2` `Register`

- `not_owner` with no details: the caller `doric`, refused by `Register`
  itself (`register.rs`, `prepare`).
- `not_owner` with the detail `type`: a type whose namespace is not the
  caller's; with the detail `prefix`: a stream prefix whose owner is not the
  caller.
- `limit_exceeded` with `details.limit` `"descriptorSet"`: a descriptor set
  over its limit, checked before any decoding.
- `invalid_input` for a set that does not decode as a `FileDescriptorSet` or
  does not resolve; `invalid_input` with the detail `type` for a bad type
  declaration (an empty or too long type id, a type of two messages, too many
  indexes or index fields, two indexes of one name, a bad index field path);
  `invalid_input` for a stored value that does not decode during a rebuild.
- `invalid_index_value` (from `schema::index_values`): during a rebuild, an
  index field that holds an object or an array.
- `limit_exceeded` with `details.limit` `"indexKey"` (from `layout::index`):
  during a rebuild, a new index key over 2,048 bytes.
- `limit_exceeded` with `details.limit` `"rebuild"`: a rebuild of a type with
  more than 100,000 documents, any rebuild (a removal included), raised before
  any decode.
- `unique_conflict` with `type`, `index` and `ids` (the holder, then the second
  document, in id key order): two documents with one key in a rebuilt unique
  index; only the first, in declared index order, is reported after the walk.
  The walk goes on after a conflict is recorded: if a later document fails to
  decode, fails `index_values` or `layout::index`, or is missing its header or
  a chunk, that error is returned instead of the recorded `unique_conflict`. No
  test yet covers the first-conflict rule across two unique indexes; the only
  conflict test has one unique index.
- `internal`: a stored type declaration that does not decode, a message
  missing from the pool when an index needs building, a missing document
  header, a stored header that does not decode, a missing chunk, or a document
  key that holds no id.

Any error rolls back the registration: the declaration, the schema,
`schema.current` and the generation stay unchanged.

The checks run in this order (`main.rs`, `Engine::register`): `prepare` (the
caller, then the set and its declarations), then `unavailable` before a
successful activation, then `apply` on the store.

### `storage/v2` `Commit` and `Get`

`Commit` (`commit.rs`, `commit/transaction.rs`) checks in this order:

1. `not_owner`: the caller `doric`.
2. Per item, as it arrives (`commit.rs:121-140`): an item with no case set;
   an item other than `event` after an `append` (`An append needs at least one
event.`); an event with no append or event before it; a chunk with no put or
   event before it; a chunk or event outside 1 byte to 1 MiB; for an expect,
   put or delete, the type's length, its namespace (`not_owner`), the id's
   length; for a `dropStream`, `truncate` or `append`, the stream id's length
   (`invalid_input`), its form (`invalid_stream`), then its owner
   (`not_owner`); an expected revision, a truncate's `afterSequence` or an
   append's `expectedSequence` not a whole number in 0..=u32::MAX, then a
   second `truncate`; then `limit_exceeded` `"batch"` for the item count, and
   for a chunk `"document"`, for an event `"append"`, then `"batch"`.
3. When the stream ends: `cancelled` if the call was cancelled, then an empty
   batch.
4. `unavailable` before a successful activation.
5. In one read transaction, per item in batch order: `unknown_type` (puts,
   expects and deletes), the decode of a put of an indexed type, its index
   values, then `limit_exceeded` `"indexKey"`.
6. In the writer: the declarations are read again and changed ones recomputed;
   the change itself is never refused, but a recomputed put can still fail with
   `invalid_input`, `invalid_index_value` or `limit_exceeded` `"indexKey"`,
   before any `revision_conflict`; then expects (`revision_conflict` with `type`, `id`,
   `expected`, `actual`), deletes, and puts (`unique_conflict` with `type` and
   `index`, checked per put against the state at that moment); then drops, the
   truncate (`invalid_input` with `stream`, `afterSequence` and `lastSequence`
   for a truncate past the stream's last sequence) and appends
   (`sequence_conflict` with `stream`, `expected` and `actual` for the first
   append whose expected sequence is not the stream's). Each header and head is
   read inside the writer's transaction (S78d).

`internal` answers a stored schema, declaration or header that is missing or
does not decode, and a revision past u32::MAX; `Get` also answers it for a
missing chunk.

A revision counts per put inside the transaction, so a delete then a put of one
document restarts at 1. Values are reassembled and split again into chunks of
983,040 bytes. `updatedAt` is in `toISOString`'s format and monotonic within the
process only; two commits may get the same value.

Descriptor pools are cached (`schema.rs`, `Pools`): 32 (`POOLS`), least
recently used, keyed by the schema's hash, in memory and per process. A failed
build is not cached, and a build runs outside the lock.

`Get` (`documents.rs`) checks `doric`, the type's length, the namespace and the
id's length, then `unavailable`, then `unknown_type`; it streams its answer
through a bounded channel, and an absent document answers no item.

### `storage/v2` `Query`

`Query` (`query.rs`) checks in this order:

1. `not_owner`: the caller `doric`.
2. `invalid_input`: no `storage_query` (`A query request holds a storage_query.`).
3. The type's length, then its namespace (`not_owner`).
4. `invalid_input`: a `limit` outside 1 to 1000
   (`A query's limit is 1 to 1000; <limit> is not.`).
5. `invalid_input`: an `order` other than absent, `asc` or `desc`
   (`A query's order is "asc" or "desc"; "<order>" is not.`).
6. The kinds of the values in `equals`, then of the bounds: a value with no kind
   is `invalid_input` (`A query value has no kind.`); a struct or a list is
   `invalid_index_value`
   (`A query value is a string, a number, a boolean or null, not a struct.`, or
   `not a list.`), and so is a non-finite number.
7. The bound pairs.
8. `invalid_input`: a cursor that is not unpadded base64url
   (`A cursor is unpadded base64url.`).
9. `unavailable` before a successful activation.
10. In the read transaction: `unknown_type`; an undeclared index
    (`Type <type> has no declared index "<index>".`); the arity, `equals` no
    longer than the index's fields and shorter when there is a range
    (`The index "<index>" of <type> has <n> fields: equality takes the leading ones and a range the next one.`);
    a cursor outside the bounds (`The cursor is outside the query's bounds.`).

A page is one read transaction, so one snapshot. It reads up to `limit` + 1
index entries, in reverse for `desc`, strictly after the cursor, and answers
the `page` item first, then each `document` item and its chunks; an empty
result is one `page` item. `next_cursor` is set only when a (`limit` + 1)th
entry exists, and is then the unpadded base64url of the tuple bytes, after
`("idx", type, name)`, of the page's last document's entry (not of the
(`limit` + 1)th entry): the values for a unique index and the values then the
id for a non-unique one. Ties on a non-unique index sort by id, bytewise.

`Query` also answers `internal` for:

- an index entry that names no stored document
  (`The index entry of "<index>" of "<type>" names no stored document "<id>".`);
- an entry that does not decode, a non-unique entry whose last element is not a
  string included (`An index entry does not decode.`);
- a missing chunk
  (`The chunk <n> of the document "<id>" of "<type>" is missing.`) or a header
  that does not decode (`A stored document header does not decode: <error>.`),
  through `emit_document` and `stored_header` (`documents.rs`).

### `storage/v2` `Read`, `PutBlob`, `GetBlob`, `DeleteBlob`, `Health` and `Watch`

Each checks the caller first: `doric` is `not_owner`
(`doric_storage::bundle`). Then, in this order:

- `Read` (`main.rs`, `streams.rs`): no `streamRead` (`invalid_input`); the
  stream id's length (`invalid_input`), its form (`invalid_stream`), its owner
  (`not_owner`); an `afterSequence` not a whole number in 0..=u32::MAX, a
  `limit` of 0 or less (`invalid_input`); then `unavailable` before activation;
  then, in one read transaction (`main/reads.rs`'s `stream_read`), an
  `afterSequence` above the stream's last sequence (`invalid_input` with
  `stream`, `afterSequence` and `lastSequence`), before any item, and
  `internal` for a stored head, entry or mark that does not decode.
- `PutBlob` (`main.rs`, `blobs.rs`): each chunk as it arrives,
  `limit_exceeded` `"blob"` once the bytes pass 33,554,432, or the stream's
  `Err` item; then `cancelled` if the call was cancelled; then `unavailable`
  before activation; then the errors of the write.
- `GetBlob` (`main.rs`, `blobs.rs`): `unavailable` before activation; then, in
  one read transaction, a malformed or unknown hash is `head { found: false }`
  and no error; `internal` for a missing chunk or a header that does not decode.
- `DeleteBlob` (`main.rs`, `blobs.rs`): `unavailable` before activation; a
  malformed or unknown hash is a no-op.
- `Health` (`main.rs`): `unavailable` before activation; a failed `statvfs` is
  no error but `status` `"unavailable"` with the reason `storage_unmeasurable`;
  `internal` (`The measure failed: <error>.`) when the measuring task fails.
- `Watch` (`main/watch.rs`, `watch.rs`): each type, its length
  (`invalid_input`), then its namespace (`not_owner`); then each stream, its
  length (`invalid_input`), its form (`invalid_stream`), its owner
  (`not_owner`); then `unavailable` before activation. A subscribed watcher that
  falls behind by 1,024 responses (`BUFFER`) gets the responses it holds, then
  `unavailable` with the message `Watch fell behind.`

## Limits

| Limit         | Value            | Of                                                              |
| ------------- | ---------------- | --------------------------------------------------------------- |
| `keyBytes`    | 4096 bytes       | one key; a positioned put counts `key_prefix` plus 8 bytes      |
| `valueBytes`  | 1 048 576 bytes  | one value                                                       |
| `getKeys`     | 1000             | the keys of one `Get`                                           |
| `rangeLimit`  | 1000             | the `limit` of one `Range`                                      |
| `commitItems` | 200 000          | the items of one commit, conditions included                    |
| `commitBytes` | 67 108 864 bytes | the keys and values of one commit, held in memory until it ends |

The `storage/v2` `Register` limits (`storage/src/schema.rs`): a descriptor
set of at most 2,097,152 bytes (`descriptorSet`), 16 indexes per type, 8
fields per index and a type id of at most 128 bytes.

The `storage/v2` `Commit` and `Get` limits (`storage/src/layout.rs`,
`storage/src/commit.rs`): 10,000 items (`chunk` items not counted) and 67,108,864 bytes per batch
(`batch`), 16,777,216 bytes per document (`document`), 1 MiB per chunk item, a
document id of at most 512 bytes, an index key of at most 2,048 bytes without
its prefix (`indexKey`), and stored chunks of 983,040 bytes. A `Query` page
holds at most 1000 documents (`LIMIT`, `storage/src/query.rs`). A `Register`
rebuild covers at most 100,000 documents (`rebuild`, `REBUILD_DOCUMENTS`,
`storage/src/register.rs`; RK27's measurement set it, AC4.25).

An appended event holds at most 3,145,728 bytes (`APPEND_BYTES`,
`storage/src/commit.rs`, `details.limit` `"append"`); `append` items, like
`chunk` items, are not counted toward the 10,000 items; each event is. A blob holds at most
33,554,432 bytes (`BLOB_BYTES`, `storage/src/blobs.rs`, `details.limit`
`"blob"`). A `Watch` subscriber holds at most 1,024 unread responses (`BUFFER`,
`storage/src/watch.rs`).

## Build and test

```sh
npx nx run sqlite:check
npx nx run sqlite:build
npx nx run sqlite:test
npx nx run sqlite:lint
npx nx run sqlite:format-check
npx nx run sqlite:compile
```

`check` is `@monodon/rust:check`, which runs `cargo check` and writes no
executable; `compile` (`@monodon/rust:build`) builds the `doric-sqlite`
executable. Both run on the package `doric-storage`; `test`, `lint` and
`format-check` cover both crates, and `test` has no `production`
configuration. `build` is the bundle build: it depends on `compile` and `bundle:build` and builds the native host part from
[`manifest.json`](manifest.json) (version 2, `1.0.0`, `engines.doric`
`^1.0.0`, provides `storage.kv/v1@1.0.0` and `storage/v2@2.0.0`, `host.kind`
`native`);
`bundle:test` depends on it. `doric-host:build-bundles` builds and stages
`sqlite`, its `host/command.json` naming the debug executable, and the host
image keeps only `dist/target/doric-sqlite/debug/doric-sqlite`; `sqlite` is
not in the composition yet (S84).

`engine/build.rs` generates the messages of `kv.proto` with `protox` and
`tonic-prost-build`. `test` is
`cargo test --locked -p doric-sqlite -p doric-storage --target-dir dist/target/doric-sqlite`;
the tests are unit tests in the modules, the prefix checks and their order in
`engine/src/access.rs` (inline) and `engine/src/limits/tests.rs`, the caller rule in `storage/src/kv.rs`, and
the 228 lib tests and 13 bin tests of `doric-storage` (and the 63 of
`doric-sqlite`, in `engine/src/{writer,store,limits,readers}/tests.rs`,
`engine/src/access.rs` and
`engine/src/store/foreign.rs`, E1), among them those of `storage/src/keys.rs` (its six `bounds` tests, `:384-495`), `storage/src/schema/tests.rs`,
`storage/src/schema/tests/pools.rs`,
`storage/src/schema/declarations/tests.rs`, `storage/src/register/tests.rs`,
`storage/src/register/tests/backfill.rs` (12, the 100,000-document rebuild and
the 100,001 refusal among them, in the normal suite; the 100,000 documents
carry empty `DocumentHeader::default()` headers and the change only removes an
index, so nothing is decoded),
`storage/src/layout/tests.rs`, `storage/src/commit/tests.rs`,
`storage/src/commit/tests/{apply,conflicts}.rs`,
`storage/src/commit/tests/engines.rs` (S78d's P1 and P2: two engines on one
file take turns, and no put or append of the other is lost or taken twice;
T4.3, AC4), `storage/src/{streams,blobs,health,watch}/tests.rs`,
`storage/src/documents/tests.rs`,
`storage/src/query/tests/check.rs` (13), `storage/src/query/tests/page.rs` (10)
and `storage/src/query/tests/paging.rs` (7), with the helpers of
`storage/src/query/tests.rs` (over the fixture of `storage/src/testing.rs`,
whose `a.pair/v1` has the non-unique index `byTagTitle[tag, title]`) and the 13 bin tests:
10 in `storage/src/main/tests.rs` (the order of the `Register` handler's
checks, a registration on the open store, and, from S78b, `Health` and the
blob methods before activation) and 3 inline in `storage/src/kv.rs`
(`kv::tests`, the caller rule). S78d deleted M1 and M2 of the
`DORIC_SQLITE_CACHE` setting, the two S2 tests of `outside_platform` and the
26 cache tests. The handlers `commit_documents` and `get_document` are
exercised over gRPC by CL1–CL3 of
[`storage-client.test.ts`](../../../packages/storage/tests/storage-client.test.ts);
they, `query_documents`, `read_stream` and the S78 handlers `put_blob`,
`get_blob`, `delete_blob` and `health`, by the `storage/v2` conformance kit
(S77b2, S78), whose Q cases run the queries; and `watch` by
[`watch.test.ts`](../../../packages/storage/tests/watch.test.ts). The engine's behavior over gRPC is tested from TypeScript by
`storage:test` in [`packages/storage`](../../../packages/storage/README.md),
which depends on `sqlite:compile` and spawns the debug binary: the KV
conformance suite ([`kv.test.ts`](../../../packages/storage/tests/kv.test.ts)),
the storage path and file format
([`kv-file.test.ts`](../../../packages/storage/tests/kv-file.test.ts)) and
`openTestEngine` and `openTestStorage`
([`test-engine.test.ts`](../../../packages/storage/tests/test-engine.test.ts)), and the
`storage/v2` client
([`storage-client.test.ts`](../../../packages/storage/tests/storage-client.test.ts)),
and the `storage/v2` conformance kit
([`storage.test.ts`](../../../packages/storage/tests/storage.test.ts),
[`storage-instances.test.ts`](../../../packages/storage/tests/storage-instances.test.ts),
[`registration.test.ts`](../../../packages/storage/tests/registration.test.ts)),
none of whose cases is skipped (50, 6 and 8), and `Watch` by
[`watch.test.ts`](../../../packages/storage/tests/watch.test.ts).
The golden file
[`storage/tests/fixtures/index-keys.json`](storage/tests/fixtures/index-keys.json)
holds 18 tuples with their bytes, the four platform keys (`layout`,
`migration`, `identity`, `host`) and the index keys the engine produces for
the messages of the fixture
[`storage/tests/fixtures/index_keys.proto`](storage/tests/fixtures/index_keys.proto),
which is outside every buf module and is compiled by `protox`. The one golden
test, `the_golden_file_holds_what_the_engine_produces` in
`storage/src/schema/tests.rs`, fails when the file differs; regenerate it with
`DORIC_WRITE_GOLDEN=1 cargo test -p doric-storage --lib` and review the diff.
[`index-parity.test.ts`](../../../packages/storage/tests/index-parity.test.ts)
(T4.23), in `storage:test`, recomputes every key with `keys.ts` and
protobuf-es.
`storage:test-heavy`, which also depends on `sqlite:compile`, runs the kit's
heavy cases: the 200,001-item `commitItems` case runs only there.
Report-only, not tests: `storage:bench-rk27` runs RK27's write-stall
measurements on the release binary, which `sqlite:compile:production` builds
(its first command). `lint` is clippy with `-D warnings`; `format-check` is
`cargo fmt --check -p doric-sqlite -p doric-storage`.

Known limitation: `cargo doc` warns of an output filename collision between
the binary `doric-sqlite` and the library `doric_sqlite`.

## Later slices

- S74b (done): the TypeScript `Kv` client, the KV conformance suite and
  `openTestEngine`, in [`packages/storage`](../../../packages/storage/README.md).
- S75b (done): the bundle's manifest; `build-bundles` stages it, but no host
  runs it until it joins the composition.
- S76 (done): the split into `engine/` and `storage/`, `KvEngine`, and
  `storage.kv/v1` served only to `doric`.
- S77a1 (done): the library's `keys` and `schema` and the golden file.
- S77a2 (done): `layout.proto`, `storage/build.rs`, and `storage/v2`'s
  `Register` served by this bundle.
- S77a3 (done): `storage/v2`'s `Commit` and `Get`, and the pool cache (S77a3a);
  `keys::bounds` and `storage/v2`'s `Query` (S77a3b).
- S77a4a (done): changed indexes on a type that has documents, with a rebuild.
- S77a4b (done): the cache of document headers (`DORIC_SQLITE_CACHE`) and the
  engine's `data_version` fix; S77a is done.
- S77b1 (done): the TypeScript client of `storage/v2`, and the suspension of
  the cache by a `storage.kv/v1` commit outside `doric/`.
- S77b2 (done): the `storage/v2` conformance suites; S77b is done.
- S77c (done): RK27's write-stall measurements (`storage:bench-rk27`, on the
  release binary).
- S77c2 (done): the `rebuild` limit lowered to 100,000 documents on S77c's
  measurement.
- S78a (done): `storage/v2`'s streams: `Commit`'s stream items, `Read`, and
  the stream heads in the cache.
- S78b (done): blobs and health.
- S78c (done): `Watch`; S78 is done.
- S78d (done, not yet committed): the cache of document headers and stream
  heads removed (A84); every write reads them inside the writer's transaction,
  and `DORIC_SQLITE_CACHE` is no longer read.
- S84: `sqlite` in the composition.
- S88: read-only mode, with the inspection tool; the spec records the deferral.
