# storage

The protocol package of `storage.backend/v1`, Doric's storage backend contract.
It holds what every implementation of that contract must agree on, so that two
backends store, order and refuse data the same way: the index-key encoding, the
query cursor, the stream-id rule, the conflict and limit errors and the batch
accounting. It also holds an in-memory implementation of `storage.backend/v1`
and `secrets.backend/v1`, which is the executable reference of the protocol and
the storage of unit tests, and the conformance kit that every storage backend
passes. Since slice S77b1 it also holds the `storage/v2` client, `openStorage`,
through which a bundle stores its documents (below).

Phase 4 of [`grpc-processes.md`](../../docs/designs/grpc-processes.md) adds the
key-value side of storage: the `Kv` client of `storage.kv/v1`, the contract of
the `sqlite` engine bundle ([sqlite README](../../bundles/foundation/sqlite/README.md));
the KV conformance kit `runKvConformance`; and `storage/testing`, which spawns
that engine for a test. `storage/memory` and the `storage.backend/v1`
conformance suites stay until slice S85a deletes them. There is no storage
library over `Kv` (A79): the engine owns the layout.

Since slice S77b1 the package root also exports the `storage/v2` client
(`src/client/`): `openStorage(context, files)` registers the bundle's
descriptor files once (a descriptor set of at most 2,097,152 bytes, checked
before any call, else `limit_exceeded` with `details.limit` `"descriptorSet"`) and answers a `Storage` with `get`, `query`,
`commit`, `read`, `health`, `putBlob`, `getBlob` and `deleteBlob`. Values are
checked against their type and protovalidate before they are written
(`invalid_input` with `{type, id}` and the first violation), stored in chunks
of at most 1 MiB, and a value that does not decode is `invalid_output`. Until
S78 the engine refuses stream items (`invalid_input`, "Stream items are not
supported."), and `read`, `health` and the blob methods answer
`unknown_contract`. The client's own refusals, made before any call, are
`invalid_input`, and a call's signal or deadline makes it `cancelled` or
`deadline_exceeded`; `limit_exceeded` (`"descriptorSet"`) comes only from
`openStorage` and the registration that `TestEngine.storage` shares with it. `storage/testing` adds
`TestEngine.storage(bundleId, files, generation = 1)` and
`openTestStorage(bundleId, files)`, whose `TestStorage {storage, kv, reset,
close}` registers the files again after each `reset()`, since the KV clear
deletes the declarations. The conformance messages `Note`, `Thread` and
`Plain` are in `proto/doric/storage/conformance/v1/conformance.proto`,
generated into `src/contracts/gen/` (`./contracts/gen/*`, target
`generate-proto`).

Since slice S77b2 the `storage/v2` conformance kit is in
`src/conformance/v2/`, not exported; the v1 kit in `src/conformance/` is
unchanged. `runStorageV2Conformance(options)` (`v2/index.ts`) opens a
`V2Harness` over a spawned engine before the cases and closes it after them,
as `runKvConformance` does, with a default timeout of 120 s per case; the case
lists are `storageV2Cases`, `instanceV2Cases` and `registrationV2Cases`
(`v2ConformanceCases` holds all three). `V2Harness` (`v2/harness.ts`) has
`open(bundleId?, files?, generation?)`, `raw(caller, generation)`, `reset()`
and `fresh()`, a new engine for a case of generations, since `reset()` keeps
the remembered highest generation; the kit closes it when the case ends.
`openV2Harness(options?: V2HarnessOptions {name, openEngine})` answers a
`V2HarnessHandle`, a `V2Harness` with `close()`, and `V2RunOptions` holds
`name`, `cases`, `openEngine`, `skip` and `timeout`. Its 63 cases are 41
active ones, D1–D7, `T4.3-prefix` and `T4.3-16MiB` (`documents.ts`), R1–R3
(`revisions.ts`), Q1–Q4 (`indexes.ts`), Q5, Q6 and T4.9 (`paging.ts`),
Q7–Q10 and T4.23 (`keyed.ts`), C1, C4 and `not_owner` through raw clients
(`concurrency.ts`), the document parts of X1, X2 and X5 (`failure.ts`), L2,
`L2-bytes` and L3 (`limits.ts`, no L1), REG1–REG5 (`registration.ts`) and
GEN1–GEN3 (`generations.ts`, each on `fresh()`), and 22 skipped ones, skipped
with the reason `S78: streams` (`untilS78`) until S78 adds streams: C2, C3,
`X1-streams`, X3, X4, `X5-streams`, P1 and P2; S1–S6 and `T4.3-event-3MiB`
(`streams.ts`, an event of exactly 3,145,728 bytes round-trips and one byte
more is `limit_exceeded`); B1–B5 and `T4.3-health` (`blobs.ts`); and
`not_owner-streams` (`concurrency.ts`, run by `storage-instances.test.ts`). The cases also pin that a range bound of
another kind is allowed, an empty type id is `invalid_input`, a no-field index
lists every document in id order, a `Storage` registered without a type
refuses a get of it with `invalid_input` before any call, and
`limit_exceeded`'s details are exactly `{limit}`. S77b2 also fixed three drifts
of the client: an appended event is chunked like a value (an `event` item of at
most 1 MiB, then `chunk` items); an event that encodes to 0 bytes is
`invalid_input` `{stream}`; an append with no events is `invalid_input`
`{stream}`; and `dropStreams` or `truncate` on an undeclared stream is
`invalid_input`, all before any call.

The contract itself, its references and method schemas, is exported by
`bundle/contracts`
([`basic/storage.ts`](../bundle/src/contracts/basic/storage.ts),
[`basic/secrets.ts`](../bundle/src/contracts/basic/secrets.ts)). The full shape
of `storage.backend/v1` is in the
[postgres README](../../bundles/foundation/postgres/README.md#storagebackendv1-version-110),
the shipped provider, and that of `secrets.backend/v1` in the same
[README](../../bundles/foundation/postgres/README.md#secretsbackendv1-version-100).
How storage works across the core facade `storage/v1`, the backend and the
bundles that store data is in
[Storage and history](../../docs/architecture/bundles/storage.md).

## Who uses it

| Entry point           | Imported by                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `storage`             | Bundles that store documents, through `openStorage` and the `Storage` types; the `postgres` bundle, which implements `storage.backend/v1` with these helpers ([`backend.ts`](../../bundles/foundation/postgres/src/host/storage/backend.ts), [`commit.ts`](../../bundles/foundation/postgres/src/host/storage/commit.ts), [`declare.ts`](../../bundles/foundation/postgres/src/host/storage/declare.ts), [`query.ts`](../../bundles/foundation/postgres/src/host/storage/query.ts)); the `core` bundle's `storage/v1` and `events/v1` facades, which apply the same batch and stream-id rules before calling the backend ([`storage/facade.ts`](../../bundles/foundation/core/src/host/storage/facade.ts), [`events/service.ts`](../../bundles/foundation/core/src/host/events/service.ts)) |
| `storage/memory`      | Tests only: the tests of `core`, `runtime` and `mcp` and of the host, which boot over the memory backends ([`core/tests/support/router.ts`](../../bundles/foundation/core/tests/support/router.ts), [`runtime/tests/store/support.ts`](../../bundles/runtime/runtime/tests/store/support.ts), [`mcp/tests/support/world.ts`](../../bundles/features/mcp/tests/support/world.ts), [`credential-adapter.test.ts`](../../app/backend/doric-host/tests/credential-adapter.test.ts))                                                                                                                                                                                                                                                                                                             |
| `storage/conformance` | The test suite of each storage backend: `postgres` and this package's memory backend ([`postgres/tests/conformance.test.ts`](../../bundles/foundation/postgres/tests/conformance.test.ts), [`memory-conformance.test.ts`](tests/memory-conformance.test.ts)); the KV kit on the `sqlite` engine ([`kv.test.ts`](tests/kv.test.ts))                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `storage/testing`     | This package's engine tests ([`kv.test.ts`](tests/kv.test.ts), [`kv-heavy.test.ts`](tests/kv-heavy.test.ts), [`kv-client.test.ts`](tests/kv-client.test.ts), [`test-engine.test.ts`](tests/test-engine.test.ts), [`storage-client.test.ts`](tests/storage-client.test.ts)) and the `storage/v2` kit in `src/conformance/v2/`, which spawns the engine through `test-engine.ts`                                                                                                                                                                                                                                                                                                                                                                                                              |

Bundles that store documents import `openStorage` from `storage`; the others
reach storage through the core's `storage/v1` facade
([Storage and history](../../docs/architecture/bundles/storage.md)).

## Entry points

The package is ESM (`"type": "module"`) and private; it declares `bundle`,
`@bufbuild/protobuf`, `@bufbuild/protovalidate`, `@connectrpc/connect`, `tslib` and `zod` as
dependencies, and it runs on Node.js (`Buffer`, `node:crypto`, `node:fs`, and
`node:os`, `node:path`, `node:url`, and `node:test` in the kits)
([`package.json`](package.json)). Each entry resolves to `src/` under the
`@org/source` condition and to the built `dist/` otherwise.

| Specifier                 | Source                                                 | Contents                                                                                                                                                                                                                                                 |
| ------------------------- | ------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `storage`                 | [`src/index.ts`](src/index.ts)                         | Index keys, query cursors, stream ids, conflict and limit errors, batch accounting; `Kv`, `kvLimits`, `kvClient`; `openStorage` and the `Storage` types (`Storage`, `StorageQuery`, `CommitBatch`, `StreamAppend` and the rest of `src/client/types.ts`) |
| `storage/contracts/gen/*` | [`src/contracts/gen/`](src/contracts/gen/)             | The generated conformance messages `Note`, `Thread` and `Plain`                                                                                                                                                                                          |
| `storage/memory`          | [`src/memory/index.ts`](src/memory/index.ts)           | `memoryStorageBackend`, `memorySecretsBackend`, `createMemoryStore`                                                                                                                                                                                      |
| `storage/conformance`     | [`src/conformance/index.ts`](src/conformance/index.ts) | `runStorageConformance`, `runConformanceCase`, `conformanceCases` and the harness types; `runKvConformance`, `KvConformanceHarness`, `KvTarget`                                                                                                          |
| `storage/rpc`             | [`src/rpc/index.ts`](src/rpc/index.ts)                 | `serveStorageBackend`, `storageBackendClient`, `serveSecretsBackend`, `secretsBackendClient`, `serveStorage`, `storageClient` and the chunked JSON codec (`encodeJson`, `decodeJson`, `chunkBytes`, `joinChunks`, `maxChunkBytes`)                       |
| `storage/rpc/chunks`      | [`src/rpc/chunks.ts`](src/rpc/chunks.ts)               | The chunked JSON codec alone, without `node:` imports, for browser-safe callers such as `runtime/contracts`                                                                                                                                              |
| `storage/testing`         | [`src/testing.ts`](src/testing.ts)                     | `openTestEngine`, `TestEngine`, `TestEngineOptions`, `openTestStorage`, `TestStorage`                                                                                                                                                                    |
| `storage/package.json`    | [`package.json`](package.json)                         | The manifest                                                                                                                                                                                                                                             |

Every error the helpers and the memory backends raise is a `ContractError` of
`bundle/contracts`, `new ContractError(code, message, details?)`, recognized
with `isContractError` ([bundle README](../bundle/README.md#errors)); a
conformance case fails with an `AssertionError` of `node:assert/strict`.

## `storage`: protocol helpers

### Index keys

```ts
type IndexScalar = string | number | boolean | null;

function encodeIndexKey(values: readonly IndexScalar[]): Uint8Array;
function decodeIndexKey(key: Uint8Array): IndexScalar[];
function indexValues(value: unknown, fields: readonly string[]): IndexScalar[];
function keyBounds(query: Pick<StorageQuery, 'equals' | 'range'>): {
  lower: Uint8Array;
  upper: Uint8Array;
};
function compareBytes(left: Uint8Array, right: Uint8Array): number;
function compareIds(left: string, right: string): number;
function toJsonPointer(field: string): string;
```

`encodeIndexKey` encodes a tuple of index values so that comparing the bytes
compares the tuples ([`keys.ts`](src/keys.ts)). Each value is a tag byte
followed by its payload, concatenated in order:

| Value   | Encoding                                                                                                                                                  |
| ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `null`  | `0x01`                                                                                                                                                    |
| `false` | `0x02`                                                                                                                                                    |
| `true`  | `0x03`                                                                                                                                                    |
| number  | `0x04`, then the 8-byte big-endian IEEE-754 double; a negative number has every bit flipped, a positive one only its sign bit set. `-0` is encoded as `0` |
| string  | `0x05`, then the UTF-8 bytes with each `0x00` written as `0x00 0xFF`, then the terminator `0x00 0x01`                                                     |

The cross-type order is therefore `null < false < true < numbers < strings`,
numbers compare by value and strings bytewise in UTF-8, and the encoding of a
tuple is a prefix of the encoding of every longer tuple that starts with it. Three
kinds of value are refused with `invalid_index_value` ([`keys.ts`](src/keys.ts)):

- a number that is not finite: `An indexed number must be finite, not <value>.`;
- a string that holds a lone surrogate: `An indexed string must be well-formed Unicode (it holds a lone surrogate).`;
- any value that is not a string, number, boolean or `null`:
  `An indexed value must be a string, number, boolean or null, not <typeof value>.`

`decodeIndexKey` is the inverse; a byte string `encodeIndexKey` never produces
(an unknown tag, a truncated number or string, a bad escape, invalid UTF-8) is
`invalid_input` with the message `Malformed index key.`
([`keys.ts`](src/keys.ts)).

`indexValues` extracts one value per index field. A field is a dotted path,
turned into a JSON Pointer by `toJsonPointer` (`a.b` → `/a/b`, with `~`
escaped as `~0` and `/` as `~1`, RFC 6901). The pointer walks own properties of
objects and, for arrays, canonical decimal indexes. A missing path, `undefined`
or `null` gives `null`; a string, number or boolean is returned as is; an
object or array is `invalid_index_value` with the message
`The index field "<field>" holds an array; only strings, numbers, booleans and null can be indexed.`
for an array and `… holds a object; …` for an object
([`keys.ts`](src/keys.ts)).

`keyBounds` gives the byte range `[lower, upper)` of the keys a query selects:
the encoded `equals` values are the prefix, and an optional `range` bounds the
next field. With `p` the prefix, `e(v)` the encoding of one value and `FF` the
byte `0xFF` ([`keys.ts`](src/keys.ts)):

| Range bound | Bound                 |
| ----------- | --------------------- |
| `gt: v`     | lower `p · e(v) · FF` |
| `gte: v`    | lower `p · e(v)`      |
| none        | lower `p`             |
| `lt: v`     | upper `p · e(v)`      |
| `lte: v`    | upper `p · e(v) · FF` |
| none        | upper `p · FF`        |

Giving both `gt` and `gte` is `invalid_input` with the message
`A range takes either gt or gte, not both.`, and giving both `lt` and `lte` is
`invalid_input` with the message `A range takes either lt or lte, not both.` ([`keys.ts`](src/keys.ts)).

`compareBytes` compares two byte arrays lexicographically and answers a
negative, zero or positive number, a shorter prefix first. `compareIds`
compares document ids by their UTF-8 bytes, the order PostgreSQL gives with
`COLLATE "C"`; a backend breaks ties between equal index keys with it
([`keys.ts`](src/keys.ts)).

The Rust engine owns the index-key encoding: `keys.rs` and `schema.rs` of
[`sqlite`](../../bundles/foundation/sqlite/README.md)'s `doric-storage` port
`encodeIndexKey`, `decodeIndexKey`, `indexValues` and `resolvePointer` byte for
byte, and write the golden file
`bundles/foundation/sqlite/storage/tests/fixtures/index-keys.json`.
[`index-parity.test.ts`](tests/index-parity.test.ts) (T4.23) pins this module
to it: it recomputes every key of the golden file with `keys.ts` and
protobuf-es and expects the same bytes.

### Query cursors

```ts
interface CursorPosition {
  readonly key: Uint8Array; // the index key of the page's last item
  readonly id: string; // its document id
}

function encodeCursor(position: CursorPosition): string;
function decodeCursor(cursor: string): CursorPosition;
```

`encodeCursor` writes base64url of the UTF-8 JSON `{ "k": <key in base64url>,
"i": <id> }`. The cursor is opaque to callers; only a backend reads it back.
`decodeCursor` accepts only that form: a string outside the base64url alphabet,
text that is not JSON, JSON without string `k` and `i`, or a `k` outside the
base64url alphabet is `invalid_input`
with the message `The query cursor is not valid.`
([`cursor.ts`](src/cursor.ts)). A query that resumes from a cursor returns the
items strictly after `(key, id)` in its order.

### Stream ids

```ts
const streamIdPattern: RegExp; // /^[a-z][a-z0-9-]*(\.[a-z0-9-]+)+\/[^\s]+$/

interface StreamId {
  readonly owner: string; // the first segment: the bundle that owns the stream
  readonly family: string; // everything before the first slash, owner included
  readonly key: string; // everything after the first slash
}

function parseStreamId(id: string): StreamId;
```

A stream id is `<owner>.<family>/<key>`: a qualified family name whose first
segment is the owning bundle, a slash, and a non-empty key without whitespace.
`parseStreamId("runtime.thread.events/t1")` answers
`{ owner: 'runtime', family: 'runtime.thread.events', key: 't1' }`. An id that
does not match `streamIdPattern` is `invalid_stream`, with the message
`"<id>" is not a stream ID of the form <owner>.<family>/<key>.` and the details
`{ stream: id }` ([`streams.ts`](src/streams.ts)).

### Conflict and limit errors

Each function builds, and does not throw, the `ContractError` a backend raises
([`errors.ts`](src/errors.ts)):

| Function                                           | Code                | Message                                                                                                                                                       | Details                                                               |
| -------------------------------------------------- | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| `revisionConflict({ type, id }, expected, actual)` | `revision_conflict` | `Document <type> <id> is at revision <actual>, not <expected>.`                                                                                               | `{ type, id, expected, actual }`                                      |
| `sequenceConflict(stream, expected, actual)`       | `sequence_conflict` | `Stream <stream> is at sequence <actual>, not <expected>.`                                                                                                    | `{ stream, expected, actual }`                                        |
| `uniqueConflict(type, index)`                      | `unique_conflict`   | `Another <type> document already holds this key of the unique index "<index>".`                                                                               | `{ type, index }`                                                     |
| `limitExceeded(what, limit)`                       | `limit_exceeded`    | by `what`: `The commit batch holds more than <limit> items.`, `A document is larger than <limit> bytes.` or `An appended event is larger than <limit> bytes.` | `{ what, limit }`, `what` being `'batch'`, `'document'` or `'append'` |

A revision of 0 means the document is absent.

`limit_exceeded` has two shapes. These helpers put the number in
`details.limit`, next to `what`; `Kv` puts the name of the limit there, one of
the names of `kvLimits` ([`Kv`](#kv-the-client-of-storagekvv1)).

### `Kv`: the client of `storage.kv/v1`

`Kv` is the TypeScript face of the `sqlite` engine's `KvService`
([`kv.ts`](src/kv.ts)), which serves only the platform, the caller `doric`:

```ts
interface Kv {
  get(request: GetRequest, call?: CallArg): AsyncIterable<GetResponse>;
  range(request: RangeRequest, call?: CallArg): AsyncIterable<RangeResponse>;
  commit(
    items: Iterable<CommitRequest> | AsyncIterable<CommitRequest>,
    call?: CallArg,
  ): Promise<CommitResponse>;
}
```

- `get` yields one answer per key, in request order; an absent key has no
  `value` and version 0.
- `range` yields at most `limit` entries of `[start, end)` in unsigned bytewise
  order, or reversed with `reverse`, without values when `keysOnly` is set.
- `commit` sends its items as one commit and resolves with its `position` once
  it is durable: above every earlier commit's, and the version of every key it
  wrote. Mutations apply in item order, all or none; the first condition that
  fails rejects the commit with `condition_failed`. A commit with no mutation
  is `invalid_input`.

A refused call reads or writes nothing, and each `get` or `range` reads one
committed state. `kvLimits` is frozen and names the limits as
`limit_exceeded` reports them in `details.limit`:

| Limit         | Value               |
| ------------- | ------------------- |
| `keyBytes`    | 4096                |
| `valueBytes`  | 1 048 576 (1 MiB)   |
| `getKeys`     | 1000                |
| `rangeLimit`  | 1000                |
| `commitItems` | 200 000             |
| `commitBytes` | 67 108 864 (64 MiB) |

Every refusal is a `ContractError` with the contract's code and details:

| Code                | When                                                                                                                                                            | Details                           |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------- |
| `invalid_input`     | a `get` with no keys; a `range` with `limit` 0; a `start` after `end` in a `range` or a `clearRange`; a commit item with no case set; a commit with no mutation | —                                 |
| `limit_exceeded`    | a limit of the table above is passed                                                                                                                            | `{ limit }`, the limit's name     |
| `not_owner`         | any caller but `doric`, before any other check (message `storage.kv/v1 serves only the platform.`)                                                              | —                                 |
| `condition_failed`  | the first condition that fails, in item order                                                                                                                   | `{ key }`, the key in hexadecimal |
| `cancelled`         | the call's signal aborted                                                                                                                                       | —                                 |
| `deadline_exceeded` | the call's deadline passed                                                                                                                                      | —                                 |
| `unavailable`       | the engine cannot be reached                                                                                                                                    | —                                 |

The engine serves only the caller `doric`, the platform: any other caller is
`not_owner` before any limit, store or I/O. The library `doric-sqlite` also
checks each key against the caller's prefix (`engine/src/limits.rs`), but over
`storage.kv/v1` that check never refuses, since `doric` passes every key. It
then checks a call in a fixed
order and answers the first refusal:

- `get`: no keys; more than `getKeys` keys; then, key by key, the caller's
  prefix and `keyBytes`.
- `range`: `limit` 0; `limit` above `rangeLimit`; `start` after `end`; the
  prefix of `start`, then of `end`; then `keyBytes`.
- `commit`, item by item as they arrive: no case set; the prefix; `keyBytes`
  (a positioned put counts its `key_prefix` plus 8 bytes); `valueBytes`; a
  `clearRange` whose `start` is after its `end`; `commitItems`; `commitBytes`
  (every key an item names plus every value). Each item's prefix is thus
  checked before `commitItems`. Once the items end, a commit with no mutation
  is `invalid_input`; conditions are checked inside the transaction.

The engine's side of these errors is in the
[sqlite README](../../bundles/foundation/sqlite/README.md#errors).

`kvClient(client)` adapts a Connect client of `KvService` to a `Kv`. It maps
transport codes as `clientFailure(error, call?)` of [`rpc/call.ts`](src/rpc/call.ts) does:
`CANCELLED` becomes `cancelled`, `DEADLINE_EXCEEDED` becomes
`deadline_exceeded` and `UNAVAILABLE` becomes `unavailable`, while a Doric
refusal keeps its code and details. When the call's signal has aborted or its
deadline has passed, an `internal` or `cancelled` failure answers `cancelled`
or `deadline_exceeded` instead, so the `Kv` errors above hold for the client. A `Call` or `CallOptions` becomes the Connect options
of its signal and deadline; an already-aborted signal rejects with `cancelled`
before any call. The client's transport fixes the caller every call is stamped
with.

### Batch accounting

```ts
const defaultStorageCapabilities: StorageCapabilities; // frozen
function batchSize(batch: CommitBatch): number;
function jsonBytes(value: unknown): number;
function checkBatchLimits(
  batch: CommitBatch,
  limits: StorageCapabilities,
): void;
```

`defaultStorageCapabilities` is `{ maxBatch: 10_000, maxDocumentBytes:
268_435_455, maxAppendBytes: 268_435_455 }`: ten thousand items, so that one
atomic deletion of a Project fits, and the PostgreSQL `jsonb` ceiling per
document and per appended event ([`batch.ts`](src/batch.ts)).

`batchSize` counts the entries of `expect`, `put`, `delete` and `dropStreams`,
one for `truncate` when present, and every event of every `append`.
`jsonBytes` is the UTF-8 length of `JSON.stringify(value)`, `undefined`
counting as `null` ([`batch.ts`](src/batch.ts)).

`checkBatchLimits` refuses a batch before anything is written, in this order:
an empty batch is `invalid_input` (`A commit batch must hold at least one
item.`); more than `maxBatch` items is `limitExceeded('batch')`; a `put` value
over `maxDocumentBytes` is `limitExceeded('document')`; an appended event over
`maxAppendBytes` is `limitExceeded('append')` ([`batch.ts`](src/batch.ts)).
The core's `storage/v1` facade calls it with the backend's capabilities, and
each backend calls it again on commit
([`storage/facade.ts`](../../bundles/foundation/core/src/host/storage/facade.ts),
[`commit.ts`](../../bundles/foundation/postgres/src/host/storage/commit.ts)).

## `storage/memory`: the in-memory backends

The memory backends implement the protocol in process, with every operation
answered as a promise but run whole, synchronously, before any other call
starts, so operations never interleave ([`later.ts`](src/memory/later.ts)).
They are never part of a shipped composition.

### `createMemoryStore` and the store

```ts
function createMemoryStore(): MemoryStore;

interface MemoryStore {
  readonly types: Map<string, readonly MemoryIndex[]>; // declared types
  readonly documents: Map<string, Map<string, MemoryDocument>>; // type → id → document
  readonly indexEntries: Map<string, Map<string, Map<string, Uint8Array>>>; // type → index → id → key
  readonly streams: Map<string, MemoryStream>;
  readonly commits: MemoryCommit[]; // the feed, in position order
  readonly blobs: Map<string, Uint8Array>; // sha256 hex → bytes
  identity: StorageIdentity | undefined; // created by the first identity()
}

interface MemoryIndex {
  readonly name: string;
  readonly fields: readonly string[];
  readonly unique: boolean;
}
interface MemoryDocument {
  readonly revision: number;
  readonly value: unknown;
  readonly updatedAt: string;
}
interface MemoryStreamEntry {
  readonly sequence: number;
  readonly value: unknown;
  readonly createdAt: string;
}
interface MemoryTruncation {
  readonly afterSequence: number;
  readonly atSequence: number;
  readonly position: number;
}
interface MemoryStream {
  lastSequence: number;
  entries: MemoryStreamEntry[];
  truncations: MemoryTruncation[];
}
interface MemoryCommit {
  readonly position: number;
  readonly documents: readonly { readonly type: string; readonly id: string }[];
  readonly streams: readonly string[];
  readonly truncated: readonly string[];
  readonly dropped: readonly string[];
}
```

The store is the state behind the memory storage backend, created empty
([`store.ts`](src/memory/store.ts)). It outlives any backend instance, so a
test can drop an instance, as if its process died, and open another over the
same data. Callers change it only through a backend.

### `memoryStorageBackend`

```ts
interface MemoryStorageOptions {
  readonly limits?: Partial<StorageCapabilities>; // over defaultStorageCapabilities
  readonly health?: () => StorageHealth; // { status: 'ok', writable: true } by default
}

function memoryStorageBackend(
  store: MemoryStore,
  options?: MemoryStorageOptions,
): ServiceDefinition<'storage.backend/v1', …>; // defineService(StorageBackendV1, …)
```

It returns the service definition of `storage.backend/v1` that a bundle passes to `services.provide`, built with
`defineService` and the contract's method schemas, so a dispatcher validates
every input and output ([`storage-backend.ts`](src/memory/storage-backend.ts),
[bundle README](../bundle/README.md#definemethod-and-defineservice)). Its
limits are `defaultStorageCapabilities` overridden by `options.limits`. Values
are stored and returned as JSON copies (`undefined` becomes `null`), so a
caller never shares an object with the store. Each method
([`storage-backend.ts`](src/memory/storage-backend.ts)):

- **`declareType({ type, indexes })`.** An index name given twice is
  `invalid_input` (`Type <type> declares an index name twice.`). A declaration equal to the stored one does nothing.
  Otherwise the index entries of every stored document of the type are built
  first, and only when every one succeeds do the declaration and the entries
  replace the previous ones; a value that cannot be indexed
  (`invalid_index_value`) or a duplicate key of a unique index
  (`unique_conflict`) leaves the previous declaration and entries in place. A
  declaration never deletes a document, and a document of an undeclared type
  is stored and read without index entries.
- **`get({ type, id })`.** The document `{ type, id, revision, value }`, or
  `undefined`.
- **`query(request)`.** Reads one declared index of the type: an unknown index,
  or any index of an undeclared type, is `invalid_input`
  (`Type <type> has no declared index "<index>".`), and so is an `equals`
  longer than the index's fields or a `range` with no field left after
  `equals`
  (`The index "<index>" of <type> has <n> fields: equality takes the leading ones and a range the next one.`). It selects the entries inside
  `keyBounds`, orders them by key and then by `compareIds`, ascending or, for
  `order: 'desc'`, descending, skips up to the decoded cursor, and answers at
  most `limit` documents with a `cursor` of the last one when more remain.
- **`read({ stream, afterSequence, limit })`.** Reading after the stream's
  `lastSequence` is `invalid_input`
  (`Stream <stream> cannot be read after <afterSequence>: its last sequence is <lastSequence>.`)
  with the details `{ stream, afterSequence, lastSequence }`. Otherwise it answers up to `limit` entries with a sequence
  above `afterSequence` (`{ sequence, value, createdAt }`), `lastSequence`, and
  the truncation marks `{ afterSequence, atSequence }` with
  `mark.afterSequence < afterSequence <= mark.atSequence`. An absent stream
  reads as empty at 0.
- **`commit(batch)`.** Applies the batch atomically, described below, and
  answers `{ position }`.
- **`feed({ after, limit })`.** Up to `limit` feed entries with a position
  above `after`, each `{ position, documents, streams, truncated, dropped }`.
- **`putBlob(base64)`.** A string that is not canonical base64 (only the
  characters `A–Z`, `a–z`, `0–9`, `+` and `/`, a length that is a multiple of
  four, at most two `=`, only at the end) is `invalid_input`
  (`A blob must be base64 bytes.`). It
  stores the bytes under their SHA-256, once, and answers
  `{ hash: 'sha256:<hex>' }`.
- **`getBlob(hash)`.** The bytes as base64, or `undefined` for an unknown hash
  or one not of the form `sha256:<64 lowercase hex>`.
- **`deleteBlob(hash)`.** Removes the blob; an unknown or malformed hash is a
  no-op.
- **`capabilities()`.** A copy of its limits.
- **`health()`.** `options.health()` or `{ status: 'ok', writable: true }`.
- **`identity()`.** The store's identity, created on the first call as
  `{ hostId: randomUUID(), storageGeneration: 1 }` and the same for every later
  call and every instance over the store.
- **`connect()`.** Does nothing: there is no connection to open.

**Commit.** `checkBatchLimits` runs first. The batch is then applied in this
order inside an undo log, each change recording its inverse
([`storage-backend.ts`](src/memory/storage-backend.ts)):

1. `expect`: every `{ type, id, revision }` must match the stored revision, 0
   for an absent document, or the commit fails with `revisionConflict`.
2. `delete`: each existing document is removed with its index entries; an
   absent one is skipped.
3. `put`: each value is stored at the previous revision plus one (1 for a new
   or deleted document), with `updatedAt` the commit's time, and its index
   entries replace the old ones. An unindexable value is
   `invalid_index_value`; a unique key another document holds at that point of
   the batch is `uniqueConflict`. Puts apply in batch order, so a put may take
   a key an earlier put of the batch freed, but not one a later put frees.
4. `dropStreams`: each stream is removed with its entries and marks; it starts
   again at sequence 1.
5. `truncate` (one stream): `afterSequence` above the stream's `lastSequence`
   is `invalid_input`
   (`Stream <stream> cannot be truncated after <afterSequence>: its last sequence is <lastSequence>.`)
   with the details `{ stream, afterSequence, lastSequence }`; otherwise the entries after `afterSequence` are removed and the counter is
   kept.
6. `append`: an `expectedSequence` that differs from the stream's
   `lastSequence` is `sequenceConflict`; an `append` without `expectedSequence`
   is never refused for its sequence. Each event takes the next sequence and,
   as `createdAt`, the commit's time (ISO-8601 with milliseconds, UTC). A
   stream dropped earlier in the batch is at 0 here, so its append starts at 1.

Any error replays the undo log in reverse and rethrows, so a failed batch
leaves nothing behind and takes no position. A batch that applies takes the
next feed position, starting at 1 and without gaps; a truncation records its
mark with `atSequence` set to the stream's counter after the whole batch,
appends of the same batch included; and the feed entry lists, each once at
its first occurrence, every document named in `delete` (absent ones included)
and then in `put`, as `{ type, id }`; the streams of `append`, in batch order;
the stream of `truncate`, if any; and every stream named in `dropStreams`,
absent ones included. A batch with only `expect` entries also takes a
position, with an empty entry.

### `memorySecretsBackend`

```ts
interface MemorySecretsOptions {
  readonly keyConfigured?: boolean; // true by default
  readonly rows?: readonly StoredSecret[]; // plaintext rows present before the first call
}

function memorySecretsBackend(
  options?: MemorySecretsOptions,
): ServiceDefinition<'secrets.backend/v1', …>; // defineService(SecretsBackendV1, …)
```

It implements `secrets.backend/v1` as the PostgreSQL `credential` table
without its encryption: rows keyed by id, unique by `(kind, name)`, kept in
plaintext in the instance ([`secrets-backend.ts`](src/memory/secrets-backend.ts)).
Every call answers copies. `options.rows` is copied as given, without a check
of `(kind, name)` uniqueness; a later row with the same id replaces an earlier
one.

- **`get(id)`.** The row, or `undefined`.
- **`list()`.** Every row, ordered by name by UTF-16 code unit; rows with the
  same name keep their insertion order.
- **`put(record)`.** Inserts or replaces the row of `record.id`. An update
  keeps the stored `kind` and `createdAt`; `updatedAt` is now, and the
  caller's `createdAt` and `updatedAt` are ignored. Another row of the same
  kind and name is `credential_name_taken`
  (`A <kind> credential named "<name>" is already stored.`). It answers
  `undefined`.
- **`delete(id)`.** `'deleted'`, or `'missing'` when no row has the id.

With `keyConfigured: false` it refuses as the PostgreSQL backend does without
`DORIC_CREDENTIAL_KEY`: a `put` whose record has a `secret`, empty or not, is
`credential_storage_unavailable`
(`DORIC_CREDENTIAL_KEY is required to store a credential secret.`), and a
`get` of a row that holds a non-empty secret, or a `list` while any row holds
one, is `credential_key_required`
(`DORIC_CREDENTIAL_KEY is required while a stored credential holds a secret.`)
([`secrets-backend.ts`](src/memory/secrets-backend.ts)).

## `storage/rpc`: the backends over the router

Temporary: phase 4 of
[`grpc-processes.md`](../../docs/designs/grpc-processes.md) deletes it with
`storage.backend/v1`. It carries `storage.backend/v1` and `secrets.backend/v1`
over the router in the shapes of "Storage until phase 4".

- **Codec.** A value crosses as JSON text in UTF-8, in chunks of at most
  `maxChunkBytes` (1 MiB) sent after its item.
- **`serveStorageBackend(backend)` / `serveSecretsBackend(backend)`** turn a
  `StorageBackend` / `SecretsBackend` into the service implementation;
  **`storageBackendClient(client)` / `secretsBackendClient(client)`** turn a
  client of the service back into the interface.
- **Errors.** A backend's `ContractError` crosses with its code and details. The
  client refuses a value JSON cannot hold with `invalid_input` before sending; a
  malformed answer stream is `invalid_output`; a transport cancel, deadline or
  unavailability becomes `cancelled`, `deadline_exceeded` or `unavailable`.

- **`serveStorage(facade, { validators, instances? })` /
  `storageClient(client, { registrations? })`** carry `storage/v1`. The facade
  receives the caller's full call; its `defineType` may return a `Promise`
  (S39a). `DefineType` carries the type's JSON Schema as
  a `Struct` and answers a fresh `registrationId`; `Undefine` from the defining
  bundle, or `InstanceGone` of the defining instance, disposes it (an unknown id
  or another bundle's id is a no-op). The client's `defineType` returns a
  `Disposable` at once and orders later calls after pending `DefineType` and
  `Undefine`; with `registrations` it replays the definitions to a new core
  instance; `settled()` reports refusals.

The conformance kit runs over the router with the memory backend
([`rpc-conformance.test.ts`](tests/rpc-conformance.test.ts)).

## `storage/conformance`: the conformance kit

The entry holds two kits. This section's kit is the set of cases every
`storage.backend/v1` implementation must pass; the KV kit, for
`storage.kv/v1` engines, follows it
([the KV kit](#storageconformance-the-kv-kit)). It registers them as `node:test` tests and asserts with
`node:assert/strict` ([`index.ts`](src/conformance/index.ts)).

### The harness

```ts
interface ConformanceInstance {
  readonly backend: StorageBackend; // reached through the real dispatcher
}

interface ConformanceOpenOptions {
  readonly limits?: Partial<StorageCapabilities>;
}

interface ConformanceHarness<
  Instance extends ConformanceInstance = ConformanceInstance,
> {
  readonly name: string; // used in suite titles
  open(options?: ConformanceOpenOptions): Promise<Instance>;
  reset(): Promise<void>; // empties the store
  crash(instance: Instance): Promise<void>; // abandons it, as if its process died
  close(instance: Instance): Promise<void>; // closes it gracefully
}
```

A backend's test suite supplies the harness ([`harness.ts`](src/conformance/harness.ts)).
Every instance it opens serves the same underlying store: what one instance
commits is visible to the others and to an instance opened after another one
crashed. `open` applies the given limits as overrides of the backend's default
capabilities, and the backend should be reached through a dispatcher, so every
call is validated against the contract's schemas, as the memory harness does
with `createTestServices` ([`memory-harness.ts`](tests/support/memory-harness.ts)).

### Running the kit

```ts
interface ConformanceRunOptions {
  readonly skip?: boolean | string; // skips every case, with this reason when a string
  readonly timeout?: number; // per case, in milliseconds; 120_000 by default
}

function runStorageConformance<Instance extends ConformanceInstance>(
  harness: ConformanceHarness<Instance>,
  options?: ConformanceRunOptions,
): void;

function runConformanceCase<Instance extends ConformanceInstance>(
  harness: ConformanceHarness<Instance>,
  conformanceCase: ConformanceCase,
): Promise<void>;

interface ConformanceCase {
  readonly id: string; // stable, such as 'D1'
  readonly group: string;
  readonly title: string;
  run(harness: ConformanceHarness): Promise<void>;
}

const conformanceCases: readonly ConformanceCase[]; // frozen, in run order
```

`runStorageConformance` registers one `describe` suite per group, titled
`<harness name> storage conformance: <group>`, with one `test` per case, titled
`<id> <title>`, under the given `skip` and `timeout`
([`index.ts`](src/conformance/index.ts)). `runConformanceCase` runs one case:
it calls `reset`, runs the case over a harness that tracks the instances it
opens, and afterwards closes every instance the case did not close or crash
itself, even when the case fails ([`index.ts`](src/conformance/index.ts)).

The postgres suite, in outline (the file also fails `open` with
`skipWithoutDatabase || 'No test database.'` when no test database is
configured, and disconnects the client of each closed instance):

```ts
runStorageConformance<Instance>(
  {
    name: 'postgres',
    open: async (options) => harness.open(options),
    reset: async () => harness.reset(),
    crash: async (instance) => harness.crash(instance),
    close: async (instance) => harness.close(instance),
  },
  { skip: skipWithoutDatabase },
);
```

([`postgres/tests/conformance.test.ts`](../../bundles/foundation/postgres/tests/conformance.test.ts))

### The cases

The cases run in this order, one suite per group
([`index.ts`](src/conformance/index.ts)). Each starts from an emptied store and
reaches the backend only through `ConformanceInstance.backend`. Its documents
use the types `conformance.note/v1`, `conformance.thread/v1`,
`conformance.other/v1` and `conformance.undeclared/v1`, and its streams `conformance.note.events/*` and
`conformance.thread.events/*`. "Another instance" means a second `open` over
the same store. Each item states what a backend must do to pass.

#### `documents` ([`documents.ts`](src/conformance/documents.ts))

- **D1.** Six documents put in one batch (an object with nested arrays, a
  string with `é` and `日本`, `-12.5`, `false`, `null`, an array) read back as
  `{ type, id, revision: 1, value }` with the value deep-equal, from this
  instance and from another one.
- **D2.** The first put gives revision 1 and each later put adds one. Two puts
  of one document in one batch are two revisions, and the last value wins.
- **D3.** A deleted document reads `undefined` and other documents are
  untouched. Deleting an absent document is not an error. A document put again
  after its delete starts at revision 1, and so does a document deleted and put
  in the same batch.
- **D4.** A document never written reads `undefined`, before and after other
  puts, in the same type and in another type.
- **D5.** A batch whose `expect` does not match fails with
  `revision_conflict`, and none of its puts or deletes apply.
- **D6.** `expect` revision 0 passes while the document is absent and, once it
  exists, fails with the details `{ type, id, expected: 0, actual: 1 }`. After
  a delete it passes again. Expecting revision 1 of an absent document fails
  with `{ …, expected: 1, actual: 0 }`.
- **D7.** Documents put before any declaration keep their revisions and values
  through a `declareType`, a refused unique declaration (`unique_conflict`)
  and a declaration of no indexes.

#### `concurrency` ([`concurrency.ts`](src/conformance/concurrency.ts))

The calls of each case alternate between two instances.

- **C1.** Of 20 concurrent commits that expect revision 1 of one document,
  exactly one succeeds and 19 fail with `revision_conflict`; the document is at
  revision 2 with the winner's value. Of 12 concurrent creates that expect
  revision 0, exactly one succeeds and 11 fail with `revision_conflict`.
- **C2.** Of 10 concurrent appends with `expectedSequence: 1`, exactly one
  succeeds and 9 fail with `sequence_conflict`; the stream holds the seed at 1
  and the winner at 2.
- **C3.** 50 concurrent appends without an expected sequence produce the
  sequences 1 to 50, each of the 50 values once, and `lastSequence` 50.
- **C4.** 30 concurrent puts of distinct documents all succeed and all appear
  in a non-unique index. Of 12 concurrent puts of distinct documents with the
  same key of a unique index, exactly one succeeds and 11 fail with
  `unique_conflict`; only the winner appears in either index.

#### `revision conflicts` ([`documents.ts`](src/conformance/documents.ts))

- **R1.** A stale `expect` fails with exactly the details
  `{ type, id, expected, actual }`.
- **R2.** After another instance writes in between, the stale commit fails
  with `revision_conflict`. Re-reading and committing with the current revision
  succeeds and gives that revision plus one, visible to the other instance.
- **R3.** When one of several `expect` entries is stale, the error names that
  document (`{ …, expected: 1, actual: 2 }`), and every document and revision
  is unchanged.

#### `paginated queries` ([`indexes.ts`](src/conformance/indexes.ts))

Q1–Q9 declare `conformance.thread/v1` with the indexes `byProject`
(`projectId`, `createdAt`), `byParent` (`projectId`, `parentId`), `byOwner`
(`owner.id`), `byValue` (`value`) and, where named, the unique `byName`
(`name`).

- **Q1.** A missing field, a `null` field and a missing step of a dotted path
  all index as `null` and match an `equals` of `null`. `equals: []` selects
  every entry, and `equals` on a prefix of the fields selects that prefix. A
  query of an undeclared index, of any index of an undeclared type, or with
  more `equals` values than fields is `invalid_input`.
- **Q2.** `gt`, `gte`, `lt` and `lte`, alone or with one bound of the other
  side, bound the field after `equals`, ascending and with `order: 'desc'`. A
  range may bound the first field with `equals: []`. A range on an index with
  no field left after `equals` is `invalid_input`.
- **Q3.** Items with equal keys come in the bytewise UTF-8 order of their ids
  (`tie-`, `tie-B`, `tie-Z`, `tie-a`, `tie-é`), reversed for `desc`.
- **Q4.** Values put in reverse come back as `null`, `false`, `true`, `-1e21`,
  `-1.5`, `0`, `0.25`, `2`, `10`, `1e21`, `''`, `'B'`, `'a'`, `'ab'`, `'é'`,
  `'日'`, reversed for `desc`. Ranges and `equals` (`gt: true`,
  `gte: 0, lt: ''`, `equals: [2]`, `equals: [false]`) follow the same order.
- **Q5.** For every limit from 1 to 10, following cursors walks 9 items, which
  share keys in pairs, exactly once in each order. A page holds at most its
  limit, and a page that ends the result carries no `cursor`. A cursor that is
  not one (`'not a cursor'`) is `invalid_input`.
- **Q6.** Between two pages another instance puts a document behind the
  cursor and one ahead of it, moves one from ahead to behind and deletes one
  ahead. The next page continues with exactly the items still ahead, and a
  cursor whose own document was deleted since still continues correctly.
- **Q7.** A put that changes indexed fields removes the old entries and adds
  the new ones; dropping an indexed field moves the document to `null`. A query
  item is the whole stored document at its current revision.
- **Q8.** A deleted document leaves every index, and its unique key can be
  taken by another document.
- **Q9.** A unique violation fails with the details `{ type, index }`, and the
  batch's other puts do not apply. Puts apply in batch order: taking a key that
  a later put of the same batch frees fails, and the same puts in the other
  order succeed. A document may put the key it already holds.
- **Q10.** Declaring an index builds entries for documents already stored. A
  declaration that stored data violates fails with `unique_conflict` and
  `{ type, index }`; the previous declaration still answers queries and
  indexes new puts, and the refused index is `invalid_input` to query.
  Redeclaring an index name over other fields rebuilds its entries. One index
  name twice in a declaration is `invalid_input`. Q10 declares its own
  indexes: `byName` (`name`), then `byName` with the unique `byTag` (`tag`),
  which is refused, then `byName` over `tag`.

#### `sequence with gaps` ([`streams.ts`](src/conformance/streams.ts))

- **S1.** An absent stream reads
  `{ entries: [], lastSequence: 0, truncations: [] }`. Appends number events
  from 1; two appends to one stream in one batch continue each other, the
  second with `expectedSequence: 3`. Each stream counts its own sequences. Each
  `createdAt` matches `YYYY-MM-DDTHH:mm:ss.sssZ` and equals
  `new Date(createdAt).toISOString()`.
- **S2.** `read` answers the entries after `afterSequence`, at most `limit`,
  with `lastSequence`. A read at the end answers no entries and the counter.
  Another instance reads the same entries.
- **S3.** A truncation keeps the entries up to `afterSequence` and the counter.
  The next append takes the next counter value, and `expectedSequence` is
  checked against the counter. Reads cross the gap, and a reader in the removed
  tail reads on. A truncation at the end removes nothing; truncating after 0
  removes everything and keeps the counter.
- **S4.** A truncation committed with an append records
  `{ afterSequence: 2, atSequence: 6 }`, the counter after the batch. A read
  after `n` answers exactly the marks with `afterSequence < n <= atSequence`,
  in the order they were made. Later appends do not move them, and marks belong
  to their stream.
- **S5.** Reading or truncating after the counter is `invalid_input`, on an
  absent stream too. The counter, not the last entry left, is the bound.
- **S6.** Dropping an absent stream is not an error. A dropped stream reads
  empty at 0 with no marks and starts again at 1, and other streams are
  untouched. In one batch,
  `dropStreams` and an append with `expectedSequence: 0` restart the stream at
  1 with no marks.

#### `snapshot + cursor` ([`snapshot.ts`](src/conformance/snapshot.ts))

- **P1.** One commit puts a snapshot holding cursor 3 and appends three events
  with `expectedSequence: 0`. A writer that missed them fails with
  `sequence_conflict`, and neither its put nor its append lands. A reader that
  takes the snapshot and reads after its cursor sees every event once, later
  appends included; the snapshot stays at revision 1.
- **P2.** Two instances fold 12 events concurrently, alternating between them: each reads the snapshot and the
  entries after its cursor, then commits the new snapshot, with `expect` on its
  revision, together with one append with `expectedSequence`, retrying on
  `revision_conflict` or `sequence_conflict`. A third instance appends 12 plain
  events at the same time. Snapshot plus cursor then sees all 24 events exactly
  once, in the stream's order.

#### `feed` ([`feed.ts`](src/conformance/feed.ts))

- **F1.** Positions of sequential commits are greater than the last position
  before them and strictly increase, and `feed` answers exactly them. A reader
  that tails the feed with `limit: 7` while three instances make 40 concurrent
  commits sees each of the 40 positions, all distinct, once and in increasing
  order. A position must therefore never become visible after a greater one.
- **F2.** Each successful commit has one entry, in commit order, listing the
  distinct `{ type, id }` it put or deleted, absent deleted ones included, the
  streams it appended to, the stream it truncated and the streams it dropped,
  repeated ones once; the kit ignores the order inside each list. A batch of
  only `expect` has an entry with four empty lists. A page holds at most its
  limit and continues after `after`; past the last position it is
  `{ commits: [] }`.
- **F3.** Batches failing with `revision_conflict`, `sequence_conflict`,
  `unique_conflict`, `limit_exceeded` and `invalid_input` (an empty batch, a
  truncate past the end) leave no entry. The feed holds exactly the successful
  commits around them.
- **F4.** An instance commits six times, reads four entries, then crashes. A
  new instance reads the feed after the fourth and gets exactly the last two,
  and finds every document and event of those commits. Its next commit gets a
  greater position and follows them in the feed.

#### `commit failure` ([`failure.ts`](src/conformance/failure.ts))

Every case starts from a store with the limits
`{ maxBatch: 8, maxDocumentBytes: 64, maxAppendBytes: 64 }`, the unique
`byTitle` and the non-unique `byTag` indexes, one document, a stream truncated
after 3 of its 4 events, and a second stream. After each failure every
document, index entry, stream entry, mark and feed entry is as before, and the
next append continues at sequence 5.

- **X1.** A stale `expect`, given after every other part of the batch (delete,
  put, `dropStreams`, truncate, append), fails with `revision_conflict`.
- **X2.** A unique key held by a stored document, or by an earlier put of the
  same batch after a delete, fails with `unique_conflict`; an object in an
  indexed field after a valid put fails with `invalid_index_value`.
- **X3.** A `sequence_conflict` after a truncate fails the batch. So does an
  append with `expectedSequence: 1` to a stream dropped in the same batch,
  which is at 0.
- **X4.** A batch over `maxBatch`, a put over `maxDocumentBytes` and an event
  over `maxAppendBytes` fail with `limit_exceeded`.
- **X5.** An empty batch, a batch of empty lists, a truncate after the counter
  and a truncate of a stream dropped in the same batch fail with
  `invalid_input`.

#### `blobs` ([`blobs.ts`](src/conformance/blobs.ts))

- **B1.** `putBlob` answers `sha256:` and the lowercase hex SHA-256 of the
  bytes. The same bytes give the same answer again, from another instance too,
  and `getBlob` answers the same base64. The empty blob is
  `sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855` and
  reads back as `''`. Blobs take no feed position.
- **B2.** 512 bytes covering every value from 0 to 255 round trip exactly
  through another instance; `'not base64!'` is `invalid_input`.
- **B3.** `sha256:` with 64 zeros, `md5:abc` and `''` read `undefined`.
- **B4.** A blob of 6 MiB (`6 * 1024 * 1024` bytes) round trips with the right
  hash.
- **B5.** `deleteBlob` removes one blob, for every instance, and leaves the
  others; deleting it again and deleting `md5:abc` succeed.

#### `limits` ([`limits.ts`](src/conformance/limits.ts))

- **L1.** Every default capability is a positive integer.
  `open({ limits: { maxBatch: 2, maxDocumentBytes: 7, maxAppendBytes: 5 } })`
  reports exactly those limits, and `open({ limits: { maxBatch: 3 } })` reports
  the defaults with `maxBatch: 3`.
- **L2.** With `maxBatch: 4`, a batch of 4 items of mixed kinds passes. Five
  puts, five appended events, or one each of `expect`, `delete`, `dropStreams`,
  `truncate` and an appended event fail with `limit_exceeded` and
  `{ what: 'batch', limit: 4 }`, and apply nothing.
- **L3.** Sizes are the UTF-8 bytes of the JSON text. With
  `maxDocumentBytes: 7`, `'12345'` (7 bytes) and `'éé'` (6) pass, and
  `'123456'` and `'ééé'` fail with `{ what: 'document', limit: 7 }`. With
  `maxAppendBytes: 5`, the limit holds per event: `['abc', 'def']` passes and
  `['ab', 'abcd']` fails with `{ what: 'append', limit: 5 }`. Failed batches
  apply nothing.

#### `health and identity` ([`identity.ts`](src/conformance/identity.ts))

- **H1.** The report parses unchanged through `storageHealthSchema` of
  `bundle/contracts`. A report with `status: 'unavailable'` has
  `writable: false` and no `disk`, and a report with `disk` has
  `disk.availableBlocks <= disk.blocks`.
- **H2.** Concurrent first `identity()` calls on two instances agree on one
  record, which parses unchanged through `storageIdentitySchema` and has
  `storageGeneration >= 1`. Later calls, a new instance, and an instance opened
  after another one committed and crashed all answer the same record.

The package's own tests prove the kit: the memory backend passes every case,
and each deliberately broken variant of it (no atomicity, sequences reused
after a truncation, a gap in the feed) fails the cases that guard what it
breaks ([`memory-conformance.test.ts`](tests/memory-conformance.test.ts),
[`kit-self.test.ts`](tests/kit-self.test.ts)).

## `storage/conformance`: the KV kit

`runKvConformance(harness, options?)` registers one `node:test` suite, titled
`harness.name`, with one test per case of `storage.kv/v1`
([`kv/index.ts`](src/conformance/kv/index.ts)). A case marked `heavy`
(`KvCase.heavy`) streams a commit of 200,001 items and takes minutes: with
`{ heavy: true }` (`KvConformanceOptions`) the suite registers only the heavy
cases, and without it every other case:

```ts
interface KvTarget {
  kv(caller: string): Kv; // every call stamped with `caller`; only `doric` is served
  reset(): Promise<void>; // removes every key of every caller
  close(): Promise<void>;
}

interface KvConformanceHarness {
  readonly name: string;
  open(): Promise<KvTarget>; // the engine, empty
}
```

The suite opens one target in `before`, resets it before each case and closes
it in `after`, even when a case fails. Its 30 cases (28 in a default run; `{ heavy: true }` runs the 2 heavy ones),
every one calling as `doric` but the refusal case,
cover range order and
reverse ranges, `limit` and continuation
([`order.ts`](src/conformance/kv/order.ts)); versions, positions, positioned
puts, conditions, item order, `clearRange` and concurrent commits
([`commit.ts`](src/conformance/kv/commit.ts)); every limit and the order of
refusals ([`limits.ts`](src/conformance/kv/limits.ts)); the caller rule, one
case refusing a caller but `doric` with `not_owner` for a `Get`, a `Range` and
a `Commit` and one where `doric` reaches every prefix
([`access.ts`](src/conformance/kv/access.ts)); and a seeded sequence of 2,000
operations checked against a model
([`random.ts`](src/conformance/kv/random.ts)). The seed is 20261127, or
`DORIC_KV_SEED` when set, and a failure names the seed and the index of the
first operation that differs. A refusal is matched on its code and `details`;
the hexadecimal `details.key` is compared without regard to case.

The `sqlite` engine runs the kit through `openTestEngine`
([`kv.test.ts`](tests/kv.test.ts)):

```ts
runKvConformance({ name: 'sqlite', open: () => openTestEngine() });
```

and runs the heavy cases in [`kv-heavy.test.ts`](tests/kv-heavy.test.ts),
with `{ heavy: true }`.

## `storage/testing`: the test engine

`openTestEngine(options?)` spawns `dist/target/doric-sqlite/debug/doric-sqlite`,
the debug build of `npx nx run sqlite:compile`, through `startTestProcess` of
`bundle/testing`, with `DORIC_STORAGE_PATH` set to its directory, and resolves
once the process is active ([`testing.ts`](src/testing.ts),
[`test-engine.ts`](src/test-engine.ts)). It finds the binary from the
repository root, the nearest directory above the module that holds `nx.json`
(`repoRoot` and `testEngineBinary(profile = 'debug')` in `test-engine.ts`,
which answers `dist/target/doric-sqlite/<profile>/doric-sqlite`;
`testEngineBinary('release')` names the release build that `bench-rk27`
measures). The internal
`openTestEngineAt(binary, options?)` answers a `TestEngine` plus
`raw(caller, generation = 1)`, raw `storage/v2` clients that the v2 kit's
`not_owner` cases use; `openTestEngine` is typed `Promise<TestEngine>`, but the
object it answers is the same one and also has `raw`.
There is no in-process `Kv`: a test that needs one opens an engine.

- Without `path`, the engine runs in a new
  `mkdtemp(join(tmpdir(), 'doric-test-engine-'))` directory, which `close()`
  removes once the process has stopped.
- With `path`, a directory the test made, `close()` leaves it in place, so a
  second engine on the same `path` reads what the first wrote.
- `kv(caller)` answers the same `Kv` for the same caller; `reset()` is one
  commit of the caller `doric` that clears every key; the engine refuses any
  caller but `doric` with `not_owner`; a second `close()`
  answers the first one's promise: while that close is pending it waits for
  it, and once it has settled it resolves at once.
- `storage(bundleId, files, generation = 1)` registers `files` (and their
  imports) as `bundleId` of `generation` and answers that bundle's `Storage`,
  every call stamped `{ bundleId, generation }` as the router stamps it, so
  its records are under `<bundleId>/`; each call registers again. It rejects
  as `openStorage` does, and with `unavailable` once the engine is closed.
- `reset()`'s clear writes outside `doric/`, so it suspends and clears the
  engine's cache of document headers. It also deletes the declarations, but it
  does not reset the engine's remembered highest generation: after
  `storage(x, f, 2)`, `reset()` and `storage(x, f, 1)`, nothing is registered,
  since generation 1 is below the highest. A test of generations uses a fresh
  engine per case.
- `openTestStorage(bundleId, files)` opens an engine of its own and answers
  `TestStorage { storage, kv, reset(), close() }`: `storage` is
  `engine.storage(bundleId, files)`, `kv` the engine's `kv('doric')`, and
  `reset()` calls the engine's `reset()` and registers the files again, so
  the next case starts on an empty store with the bundle's declarations.
- It rejects with
  `Error('doric-sqlite is not built: run npx nx run sqlite:compile')` when the
  binary is missing, and with the failure of `startTestProcess` when the
  process does not start.

```ts
import { create } from '@bufbuild/protobuf';
import { CommitRequestSchema } from 'bundle/contracts/gen/doric/storage/kv/v1/kv_pb.js';
import { openTestEngine } from 'storage/testing';

const engine = await openTestEngine();
const kv = engine.kv('doric');
const bytes = (text: string) => new TextEncoder().encode(text);

await kv.commit([
  create(CommitRequestSchema, {
    item: {
      case: 'put',
      value: { key: bytes('doric/notes/a'), value: bytes('1') },
    },
  }),
]);
await engine.close();
```

## Build and test

Run from the repository root ([`project.json`](project.json)):

```console
npx nx run storage:build      # tsc --build tsconfig.lib.json into dist/
npx nx run storage:typecheck  # tsc --build tsconfig.json --emitDeclarationOnly
npx nx run storage:test       # tsc -p tsconfig.spec.json, then node --test dist-tests/tests/*.test.js except kv-heavy
npx nx run storage:test-heavy # the same build, then node --test dist-tests/tests/kv-heavy.test.js (30 min timeout)
npx nx run storage:bench-rk27 # sqlite:compile:production, tsc -p tsconfig.spec.json, then node dist-tests/tests/bench/rk27.js (cache: false)
```

`test` depends on `generate-proto`, which generates the conformance messages
into `src/contracts/gen/`; `test-heavy` gets it through its dependency on
`build` ([`project.json`](project.json), `test-heavy`'s `dependsOn`). Both
targets depend on `sqlite:compile`, so running them needs the Rust toolchain
(cargo). Each target builds its dependencies (`bundle`) first. `bench-rk27` depends on
`generate-proto`, `^build` and `build`, and runs `sqlite:compile:production`
as its first command.

These tests spawn the debug `doric-sqlite` binary:
[`kv.test.ts`](tests/kv.test.ts), the KV kit on the engine;
[`kv-heavy.test.ts`](tests/kv-heavy.test.ts), its heavy cases, which only
`test-heavy` runs; [`kv-file.test.ts`](tests/kv-file.test.ts), the storage
path and file format; [`test-engine.test.ts`](tests/test-engine.test.ts),
`openTestEngine`; [`kv-client.test.ts`](tests/kv-client.test.ts), `kvClient`;
[`storage-client.test.ts`](tests/storage-client.test.ts), the `storage/v2`
client through `openTestStorage`; and the v2 kit,
[`storage.test.ts`](tests/storage.test.ts) (49 cases, 19 skipped),
[`storage-instances.test.ts`](tests/storage-instances.test.ts) (6, 3 skipped)
and [`registration.test.ts`](tests/registration.test.ts) (8).

The other tests do not spawn it:
[`storage-client-items.test.ts`](tests/storage-client-items.test.ts), the
items the client sends (CI1–CI10), over a recording `Storage`;
[`index-parity.test.ts`](tests/index-parity.test.ts), the index keys against
the engine's golden file; [`keys.test.ts`](tests/keys.test.ts) and
[`protocol.test.ts`](tests/protocol.test.ts), the helpers;
[`memory-backends.test.ts`](tests/memory-backends.test.ts), the memory
backends; [`rpc-backend.test.ts`](tests/rpc-backend.test.ts),
[`rpc-secrets.test.ts`](tests/rpc-secrets.test.ts),
[`rpc-storage.test.ts`](tests/rpc-storage.test.ts),
[`rpc-chunks.test.ts`](tests/rpc-chunks.test.ts) and
[`rpc-chunks-export.test.ts`](tests/rpc-chunks-export.test.ts), `storage/rpc`
and its chunked codec; and the `storage.backend/v1` kit's suites,
[`memory-conformance.test.ts`](tests/memory-conformance.test.ts),
[`rpc-conformance.test.ts`](tests/rpc-conformance.test.ts) and
[`kit-self.test.ts`](tests/kit-self.test.ts).

[`tests/bench/rk27.ts`](tests/bench/rk27.ts) is a script, not a test: it
measures RK27's write stalls over
`openTestEngineAt(testEngineBinary('release'))`, (b) three `Commit`s of 10,000
`Note` puts and 67,108,864 value bytes, then (a) a `Register` that adds the
non-unique `byTagTitle[tag, title]` over 100,000 `Note`s of 1,024 bytes,
written in 10 commits of 10,000: exactly the engine's `rebuild` limit
(`REBUILD_DOCUMENTS`), so a change to that limit must change the literal
`backfillDocuments`. It prints JSON lines: `rk27.environment`; `rk27.b`, one
line per run, three in all; `rk27.a`; and `rk27.rule`, with `backfillWithin5s`,
`rebuildLimit` (only when (a) takes over 5,000 ms) and `commitOver5s`. It
exits 1 only on an error; without the release binary it says
to run `npx nx run sqlite:compile:production`. Its results are in
[the feature doc](../../docs/features/bundle-processes.md), "Phase 4: write
stalls".

CI runs `storage:test` in its platform test step, `storage:test-heavy` in
its step "Run heavy storage tests" and `storage:bench-rk27`, report-only, in
its step "Run the RK27 measurements"
([`ci.yml`](../../.github/workflows/ci.yml)); both heavy steps have a
30-minute timeout.

## Related documents

- [Storage and history](../../docs/architecture/bundles/storage.md): the
  storage contracts, the data model and the `storage/v1` facade.
- [postgres README](../../bundles/foundation/postgres/README.md): the shipped
  backend and the full shape of `storage.backend/v1` and `secrets.backend/v1`.
- [core README](../../bundles/foundation/core/README.md#storagev1): the
  `storage/v1` facade.
- [sqlite README](../../bundles/foundation/sqlite/README.md): the
  `storage.kv/v1` engine behind `Kv` and `storage/testing`.
- [gRPC processes](../../docs/designs/grpc-processes.md): the spec of
  `storage.kv/v1`, `Kv` and the KV kit.
- [Local history](../../docs/features/local-history.md): how the storage
  identity keys the desktop's snapshots.
