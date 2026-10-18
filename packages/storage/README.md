# storage

The shared toolkit for implementing Doric's storage backend protocol,
`storage.backend/v1`. It gives backend authors the encoding and protocol
helpers every implementation must agree on, an in-memory reference backend,
and a conformance kit that proves a new backend behaves exactly like the
others. Write a backend once against these pieces and the rest of Doric can use
it unchanged.

Part of [Doric](../../README.md), where the `postgres` foundation bundle is
the shipped backend.

## What the protocol covers

`storage.backend/v1` is the set of generic storage primitives that a
foundation bundle such as `postgres` provides:

- versioned documents with declared indexes;
- streams with sequences and gaps;
- atomic declarative commits and a commit feed;
- blobs;
- health and identity.

The contract itself (types, schemas and the `StorageBackendV1` reference) lives
in `bundle/contracts`; this package holds what every backend implementation
shares.

## Entry points

| Entry                 | Audience                     | Contents                                                                                        |
| --------------------- | ---------------------------- | ----------------------------------------------------------------------------------------------- |
| `storage`             | Backend authors              | Protocol helpers: index key encoding, query cursors, stream ids, error and batch helpers        |
| `storage/memory`      | Unit tests of core and hosts | In-memory storage and secrets backends and an embedded `memory` foundation bundle               |
| `storage/conformance` | Backend test suites          | `runStorageConformance(harness)`: the cases every `storage.backend/v1` implementation must pass |

### `storage`

- Index keys: `encodeIndexKey`, `decodeIndexKey`, `indexValues`, `keyBounds`,
  `compareBytes`, `compareIds`, `toJsonPointer`.
- Query cursors: `encodeCursor`, `decodeCursor`.
- Stream IDs: `parseStreamId`, `streamIdPattern`.
- Errors: `revisionConflict`, `sequenceConflict`, `uniqueConflict`,
  `limitExceeded`.
- Batches: `batchSize`, `checkBatchLimits`, `jsonBytes`,
  `defaultStorageCapabilities`.

### `storage/memory`

`memoryStorageBackend`, `memorySecretsBackend`, `createMemoryStore`, and
`memoryFoundation`, an embedded bundle that provides both backends. The memory
backends are the executable reference for the conformance kit and are never
part of a shipped composition.

### `storage/conformance`

A backend's test suite supplies a harness and registers the kit's `node:test`
suites, one per case group:

```ts
import { runStorageConformance } from 'storage/conformance';

runStorageConformance({
  name: 'my-backend',
  // Each instance serves the same underlying store.
  open: async (options) => ({ backend: await openBackend(options?.limits) }),
  reset: async () => emptyStore(),
  crash: async (instance) => abandon(instance),
  close: async (instance) => closeGracefully(instance),
});
```

The cases cover documents, concurrency, revision conflicts, paginated queries,
sequences with gaps, snapshot and cursor, the commit feed, commit failure,
blobs, limits, health and identity. `runStorageConformance(harness, options)`
accepts `skip` and a per-case `timeout` (120 000 ms by default).

## Who imports it

Only storage backends (such as `postgres`) and the core's host part, which
applies the same stream and batch rules, import this package; every other
bundle reaches storage through the core `storage/v1` facade.

## Development

```console
npx nx run storage:build
npx nx run storage:typecheck
npx nx run storage:test
```
