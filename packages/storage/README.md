# storage

`storage` is the protocol package for `storage.backend/v1`, the generic
storage primitives that a foundation bundle such as `postgres` provides:
versioned documents with declared indexes, streams with sequences and gaps,
atomic declarative commits, a commit feed, blobs, health and identity. The
contract itself (types, schemas and the `StorageBackendV1` reference) lives in
`bundle/contracts`; this package holds what every backend implementation
shares.

| Entry                 | Audience                     | Contents                                                                                        |
| --------------------- | ---------------------------- | ----------------------------------------------------------------------------------------------- |
| `storage`             | Backend authors              | Protocol helpers: index key encoding, query cursors, stream ids, error and batch helpers        |
| `storage/memory`      | Unit tests of core and hosts | In-memory storage and secrets backends and an embedded `memory` foundation bundle               |
| `storage/conformance` | Backend test suites          | `runStorageConformance(harness)`: the cases every `storage.backend/v1` implementation must pass |

Only storage backends (such as `postgres`) and the core's host part, which
applies the same stream and batch rules, import this package; every other
bundle reaches storage through the core `storage/v1` facade. The memory backends are the executable reference for the
conformance kit and are never part of a shipped composition.

## Development

```console
npx nx run storage:build
npx nx run storage:typecheck
npx nx run storage:test
```
