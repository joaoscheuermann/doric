# history

`history` keeps, on the desktop, a local snapshot of the durable event log of
each recently used Thread, so that a window can draw a conversation before the
host answers. The snapshot is a cache: the host's durable Thread events are the
only conversation history, and the window's live stream reconciles whatever the
cache showed ([`src/desktop/index.ts`](src/desktop/index.ts),
[`src/desktop/store.ts`](src/desktop/store.ts)). The flow across bundles is
described in the feature docs
[Conversation](../../../docs/features/conversation.md) and
[Local history](../../../docs/features/local-history.md); how bundles are built
and loaded is in [`packages/bundle`](../../../packages/bundle/README.md).

## Manifest

| Field             | Value                                                                                   |
| ----------------- | --------------------------------------------------------------------------------------- |
| `manifestVersion` | `1`                                                                                     |
| `id`              | `history`                                                                               |
| `version`         | `1.0.0`                                                                                 |
| `engines`         | `doric`: `^1.0.0`                                                                       |
| `description`     | Local per-Thread conversation history snapshots for the desktop.                        |
| Parts             | `desktop` only ([`src/desktop/index.ts`](src/desktop/index.ts)); no host or client part |
| `provides`        | `history.snapshots/v1@1.0.0`                                                            |
| `requires`        | `hooks/v1@^1.0.0`                                                                       |
| `optional`        | none                                                                                    |
| `desktopScope`    | `history.snapshots/v1`: `projectId`, `threadId`, `promptId`                             |

([`manifest.json`](manifest.json)). `desktopScope` lists the scope keys a
window may send with a call to `history.snapshots/v1`; the desktop bridge
refuses a call that carries any other key with `invalid_input`
([`dispatcher.ts`](../../../app/desktop/doric/src/platform/bridge/dispatcher.ts)).
The methods themselves ignore the scope. The bundle has no settings, tools,
routes, slots or UI.

## Contract `history.snapshots/v1`

Declared in [`src/contracts/index.ts`](src/contracts/index.ts) and exported as
`history/contracts`. The build emits its descriptor in `dist/contracts.json` as
`kind: service`, `environment: desktopMain`, `cardinality: one`,
`local: false`, with the JSON Schema `schemas/history.snapshots/v1.json`. Both
methods have the exposure `'desktop'`, so a window reaches them over the
desktop bridge. Every value is plain data.

### Types

The record schemas are loose (`z.looseObject`): they check only the fields the
cache reads and keep every other field as it arrived, so the bundle depends on
no contract of the `runtime` bundle.

```ts
// A Thread record as the host sends it; only `id` is checked.
type ThreadRecord = { id: string; [key: string]: unknown };

// One durable Thread event; other fields (such as `event`) are kept.
type ThreadEventRecord = {
  projectId: string;
  threadId: string;
  promptId: string;
  sequence: number; // integer >= 0
  type: string;
  createdAt: string;
  [key: string]: unknown;
};

// One Thread's cached history (strict object).
type HistorySnapshot = {
  thread: ThreadRecord | null;
  lastSequence: number; // integer >= 0: sequence of the last event, 0 without events
  events: ThreadEventRecord[];
};

// One update a window applied, in the order it applied them (strict objects,
// discriminated by `kind`).
type HistoryUpdate =
  | {
      kind: 'snapshot';
      thread: ThreadRecord | null;
      events: ThreadEventRecord[];
    }
  | { kind: 'event'; event: ThreadEventRecord }
  | { kind: 'updated'; thread: ThreadRecord }
  | { kind: 'deleted'; projectId: string; threadId: string };

// The input of `write` (strict object).
type HistoryWrite = { threadId: string; updates: HistoryUpdate[] };
```

`events` is ascending by sequence and has one event per sequence for every log
the store merged. A file read from disk and not merged since is answered as it
is stored, and `lastSequence` is then the sequence of its last element, not the
highest one ([`src/desktop/store.ts`](src/desktop/store.ts)).

### Exports of `history/contracts`

| Export                                                                                                                | Kind                                                                |
| --------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| `ThreadRecord`, `ThreadEventRecord`, `HistorySnapshot`, `HistoryUpdate`, `HistoryWrite`                               | types, the outputs of the schemas below                             |
| `threadRecordSchema`, `threadEventRecordSchema`, `historySnapshotSchema`, `historyUpdateSchema`, `historyWriteSchema` | zod schemas                                                         |
| `HistorySnapshots`                                                                                                    | the service interface                                               |
| `HistorySnapshotsV1`                                                                                                  | `ref<HistorySnapshots>('history.snapshots/v1')`                     |
| `historySnapshotsMethods`                                                                                             | the method specs, one `{ input, output, expose }` object per method |

```ts
interface HistorySnapshots {
  read(threadId: string, call?: CallArg): Promise<HistorySnapshot | null>;
  write(input: HistoryWrite, call?: CallArg): Promise<void>;
}

const historySnapshotsMethods = {
  read: {
    input: z.string(),
    output: historySnapshotSchema.nullable(),
    expose: 'desktop',
  },
  write: { input: historyWriteSchema, output: z.void(), expose: 'desktop' },
} as const;
```

`CallArg` is the optional last argument of every stub method, a parent `call`
or `{ signal?, deadline? }`
([`packages/bundle` README](../../../packages/bundle/README.md#call)). The
scope of the call carries the `desktopScope` keys: the caller binds them with
`services.use(HistorySnapshotsV1, scope)` or passes on the scope of the call it
serves as `CallArg`; the window's bridge sends every key of that scope except
`windowKey`, and the desktop dispatcher adds `windowKey` itself
([Scope keys](../../../docs/architecture/bundles/contexts.md#scope-keys),
[`dispatcher.ts`](../../../app/desktop/doric/src/platform/bridge/dispatcher.ts)).

### Methods

| Method  | Signature                        | Output                    | Behavior                                                                                    |
| ------- | -------------------------------- | ------------------------- | ------------------------------------------------------------------------------------------- |
| `read`  | `read(threadId, call?: CallArg)` | `HistorySnapshot \| null` | The Thread's snapshot, including updates not yet written to disk; `null` when there is none |
| `write` | `write(input, call?: CallArg)`   | `void`                    | Absorbs each update for `input.threadId`, in order, and schedules a write; resolves at once |

A call is validated against the method's schemas twice: the desktop bridge
checks a window's input and the provider's output against the contract's JSON
Schema ([`dispatcher.ts`](../../../app/desktop/doric/src/platform/bridge/dispatcher.ts)),
and the dispatcher checks both against the method specs
([`packages/bundle/src/runtime/dispatch.ts`](../../../packages/bundle/src/runtime/dispatch.ts)).
A call that does not match fails with `invalid_input` (a `write` with one
malformed update absorbs none of its updates) or `invalid_output`. The methods
themselves never reject ([`src/desktop/index.ts`](src/desktop/index.ts),
[`src/desktop/store.ts`](src/desktop/store.ts)).

### Who uses it

The [`chat`](../chat/README.md) bundle lists the contract under `optional` and
reaches it with `services.whenAvailable`: a Thread it opens starts from `read`,
its watch resumes after `lastSequence`, and it hands every batch it applied to
`write`. Without a provider the chat opens a Thread from the host alone
([`index.ts`](../chat/src/client/index.ts),
[`threads-api.ts`](../chat/src/client/api/threads-api.ts),
[`thread-chats.ts`](../chat/src/client/domain/thread-chats.ts),
[`history.ts`](../chat/src/client/api/history.ts)).

## Contracts used

| Contract             | From                         | What for                                                                                                                                                                                                                                                                                                                                                                                               |
| -------------------- | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `doric.cache/v1`     | the platform                 | `directory(call?: CallArg): Promise<string>`: the bundle's own cache directory, the root of every file it writes. The desktop answers `<userData>/bundle-cache/history` and creates it when missing ([Shapes of the platform contracts](../../../docs/architecture/bundles/contexts.md#shapes-of-the-platform-contracts), [`cache.ts`](../../../app/desktop/doric/src/platform/native/cache.ts))       |
| `doric.catalog/v1`   | the platform                 | `get().storage?: StorageIdentity`, with `hostId: string` (a UUID) and `storageGeneration: number` (a positive integer), which names the snapshot namespace. It is present once the host resolved its storage backend; the desktop takes it from the host's catalog ([The contract `doric.catalog/v1`](../../../docs/architecture/bundles/composition-and-distribution.md#the-contract-doriccatalogv1)) |
| `hooks/v1`           | `core` (required)            | `use(AppHooksV1)`, to reach the app's hooks                                                                                                                                                                                                                                                                                                                                                            |
| `doric.app.hooks/v1` | the platform, via `hooks/v1` | `onBeforeQuitHook`, a `decide` hook, to write pending snapshots before the app quits ([`doric.app.hooks/v1`](../../../docs/architecture/bundles/hooks.md#doricapphooksv1))                                                                                                                                                                                                                             |

([`src/desktop/index.ts`](src/desktop/index.ts); the store's place among the
host's storage is in
[The local snapshot](../../../docs/architecture/bundles/storage.md#the-local-snapshot).)

## The desktop part

`activate` ([`src/desktop/index.ts`](src/desktop/index.ts)):

1. Awaits the cache directory from `doric.cache/v1` and reads the storage
   identity from `doric.catalog/v1.get().storage`, once.
2. With an identity, opens the store over
   `<cache directory>/<encodeURIComponent(hostId)>/<storageGeneration>`.
   Without one, uses a disabled store: `read` answers `null`, `write` keeps
   nothing, and nothing touches the disk for the rest of the activation
   ([`src/desktop/store.ts`](src/desktop/store.ts)).
3. Provides `history.snapshots/v1` over the store.
4. Registers an `onBeforeQuitHook` handler that writes everything pending and
   answers `{ allow: true }`: it never vetoes the quit.
5. Returns a cleanup that writes everything pending when the bundle
   deactivates.

### Lifecycle and concurrency

The desktop part runs in the `utilityProcess` of one desktop generation
([Desktop generations](../../../docs/architecture/bundles/process-isolation.md#desktop-generations)).
Each activation opens its own store, with its own in-memory index, eviction and
write timer ([`src/desktop/index.ts`](src/desktop/index.ts),
[`src/desktop/store.ts`](src/desktop/store.ts)):

- The Electron main loads a new desktop generation whenever the host's
  `hostId`, `hostBoot` or `generation` changes, or the window mode (for example
  `disconnected-copy`), so the bundle activates again
  with each one, and once more when a generation's process is lost after
  `ready` and respawned
  ([`app.ts`](../../../app/desktop/doric/src/platform/app.ts),
  [`process.ts`](../../../app/desktop/doric/src/platform/generation/process.ts)).
- An older generation keeps running while a window is pinned to it and stops
  once none is. Its stop deactivates its bundles, which runs this bundle's
  cleanup, and kills the process if it has not exited after 10 seconds
  ([`app.ts`](../../../app/desktop/doric/src/platform/app.ts),
  [`process.ts`](../../../app/desktop/doric/src/platform/generation/process.ts)).
- So several activations can run at once. Every generation gets the same cache
  directory, and `hostId` and `storageGeneration` stay the same across a host
  reboot, so they often open the same namespace directory. Nothing coordinates
  them: each indexes the files it found, evicts and deletes by its own count,
  and the last one to write a Thread's file wins.
- The main fires `onBeforeQuitHook` only in the newest generation, whose
  handler writes before it answers. On quit, `will-quit` starts the stop of
  every generation without waiting for it
  ([`main.ts`](../../../app/desktop/doric/src/main.ts),
  [`app.ts`](../../../app/desktop/doric/src/platform/app.ts)), so an older
  generation's pending snapshots are written only if its cleanup runs before
  the app exits, and are lost otherwise.

## Behavior of the store

All in [`src/desktop/store.ts`](src/desktop/store.ts). Every file operation is
synchronous (`mkdirSync`, `readdirSync`, `statSync`, `readFileSync`,
`writeFileSync`, `renameSync`, `rmSync` of `node:fs`): the before-quit answer
and the cleanup return only after every pending file is written, and a `read`
of a Thread the store has not loaded blocks the process on a disk read.

### Opening

The store creates its directory (recursively) and indexes every `*.json` file
already there, as Threads not yet loaded, ordered by modification time, oldest
first, with ties broken by Thread id. The Thread id of a file is the decoded
file name without `.json`. A file whose name cannot be decoded or that cannot
be stat'ed is skipped; a directory that cannot be created or listed leaves the
index empty. A malformed `.json` file is indexed like any other.

### Absorbing an update

`write({ threadId, updates })` absorbs each update in order:

- `deleted`: forgets the Thread named by the update's own `threadId` and
  deletes its file at once; `projectId` is not used. It evicts nothing and
  schedules no write.
- any other kind: takes the Thread's entry, loading its file the first time,
  and moves it to the most recently updated place. Then:
  - `snapshot`: merges the update's events into the held events; the Thread
    record becomes the update's `thread`, or stays the held one when the update
    carries `null`;
  - `event`: merges the one event into the held events and keeps the record;
  - `updated`: replaces the Thread record and keeps the events.

  The entry is marked dirty, the oldest entries are evicted while more than 20
  are held, and a write is scheduled.

### The merge rule

The held log and the incoming events become one log, ascending by `sequence`,
with one event per sequence:

- When no incoming event is a rewind marker and every incoming sequence is
  greater than the previous one, starting above the last held sequence, the
  incoming events are appended.
- Otherwise both lists are merged by sequence, the first event seen for a
  sequence winning (a held event wins over an incoming one), sorted, and every
  event a rewind marker discards is dropped.

A rewind marker is an event whose `event` payload has
`type: 'history.truncated'` and a non-negative integer `afterSequence`. It
discards every event whose sequence lies strictly between its `afterSequence`
and its own `sequence`. This is the rule the chat's projector applies
([`projector.ts`](../chat/src/client/domain/projector.ts)), so the cached log
equals what a replay of the durable log produces.

### Reading

`read(threadId)` answers the held history when the Thread is in memory, loading
its file the first time; for a Thread the store does not hold it reads the file
without indexing it. A read does not change the recency order. The answer is
`{ thread, lastSequence, events }`, with `lastSequence` the sequence of the
last event, or 0 without events. A missing, unreadable, unparsable or
malformed file reads as `null`.

A file is well formed when it is an object with a string `threadId`, a numeric
`lastSequence`, an `events` array whose every item has string `projectId`,
`threadId`, `promptId`, `type` and `createdAt` and a safe non-negative integer
`sequence`, and a `thread` that is `null` or an object with a string `id`.

### Writing

The timed write runs 250 ms after the first update that scheduled it; updates
absorbed meanwhile join it. The timed write, the before-quit handler and
deactivation all flush: the pending timer is cancelled and every dirty entry is
written. A file is written to `<file>.tmp`, which then replaces `<file>` with a
rename. An entry whose write throws stays dirty; no retry is scheduled, and it
is written again on the next flush: the timer of the next update, the
before-quit handler or deactivation.

## Data and persistence

| Aspect    | Value                                                                                                                                                                                                                                                                                                                    |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Location  | `<doric.cache/v1 directory>/<encodeURIComponent(hostId)>/<storageGeneration>/<encodeURIComponent(threadId)>.json` ([`src/desktop/index.ts`](src/desktop/index.ts) names the namespace, [`src/desktop/store.ts`](src/desktop/store.ts) the file)                                                                          |
| One file  | one Thread                                                                                                                                                                                                                                                                                                               |
| Encoding  | UTF-8 JSON, written by `JSON.stringify` ([`src/desktop/store.ts`](src/desktop/store.ts))                                                                                                                                                                                                                                 |
| Temporary | `<file>.tmp`, written first, which then replaces the file with a rename                                                                                                                                                                                                                                                  |
| Retention | No time-based expiry. A file lasts until it is evicted or removed by a `deleted` update. The bundle never removes a directory, so the namespaces of other `hostId`s and older `storageGeneration`s stay on disk, unread ([`src/desktop/index.ts`](src/desktop/index.ts), [`src/desktop/store.ts`](src/desktop/store.ts)) |

The shape of one file ([`src/desktop/store.ts`](src/desktop/store.ts)):

```ts
type SavedHistory = {
  threadId: string;
  thread: ThreadRecord | null;
  lastSequence: number; // sequence of the last event, 0 without events
  events: ThreadEventRecord[]; // as held: merged logs are ascending, deduplicated, rewinds applied
  savedAt: string; // ISO 8601 time of the write
};
```

`savedAt` is not read. A read requires `lastSequence` to be a number and
`threadId` to be a string but uses neither value: it computes `lastSequence`
from the events and answers for the Thread asked for. Because the namespace is
the host's `hostId` and `storageGeneration`, a different database or a reset
storage reads none of the snapshots another one left
([`src/desktop/index.ts`](src/desktop/index.ts),
[`src/desktop/store.ts`](src/desktop/store.ts)).

## Side effects

All in [`src/desktop/store.ts`](src/desktop/store.ts), except the hook
([`src/desktop/index.ts`](src/desktop/index.ts)):

- Creates the namespace directory when the store opens.
- Writes, renames and deletes files only inside that directory.
- Registers one `onBeforeQuitHook` handler.
- Starts a 250 ms timer while a write is pending.
- A `<file>.tmp` left by a failed rename stays in the directory; the index
  ignores it.

## Configuration

None: the bundle reads no setting. Its fixed values are in
[`src/desktop/store.ts`](src/desktop/store.ts): at most 20 Threads
(`snapshotLimit`) and a write delay of 250 ms (`writeDelayMs`).

## Limits

- At most 20 Threads are held. When an update other than `deleted` brings a
  21st, the least recently updated Thread is forgotten and its file deleted.
  Files a previous run left count, in modification order, malformed ones
  included, and are deleted when evicted; the bound is enforced on the next
  update other than `deleted` ([`src/desktop/store.ts`](src/desktop/store.ts)).
- A snapshot keeps the events absorbed since the Thread last entered the
  cache, with no bound on the number of events. Eviction deletes the file (when
  the delete succeeds), so the next update for an evicted Thread starts from an
  empty log and a `null` record. When that update carries only later events, as
  when a window still watches the Thread, the snapshot holds only the part of
  the durable log absorbed since then, and `read` answers that part with its
  `lastSequence`. The chat then reopens such a Thread from the partial log and
  watches it from that `lastSequence`, so the earlier events are never drawn
  ([`src/desktop/store.ts`](src/desktop/store.ts),
  [`thread-chats.ts`](../chat/src/client/domain/thread-chats.ts)).
- The storage identity is read once, at activation: when the catalog has none
  then, the store stays disabled until the bundle activates again, in the next
  desktop generation (see [Lifecycle and concurrency](#lifecycle-and-concurrency))
  ([`src/desktop/index.ts`](src/desktop/index.ts)).
- Only file names in `encodeURIComponent` form are removed: a file whose name
  decodes to a Thread id that encodes differently is indexed under that id, but
  eviction and deletion remove the encoded name, so the file stays
  ([`src/desktop/store.ts`](src/desktop/store.ts)).

## Errors and failure behavior

- No method of the store throws, and no failure reaches the caller: a file that
  cannot be read reads as `null`, a write that fails stays pending, a file that
  cannot be deleted stays, and a directory that cannot be indexed starts empty
  ([`src/desktop/store.ts`](src/desktop/store.ts)).
- A `deleted` update whose file cannot be removed leaves that file: a later
  `read` of that Thread reads it, because a Thread the store does not hold is
  read from disk, so the deleted Thread's history is served again, and the next
  run indexes the file again ([`src/desktop/store.ts`](src/desktop/store.ts)).
- When `doric.cache/v1.directory()` rejects, because the directory cannot be
  created, `activate` throws and the bundle
  is quarantined with `activate_failed`
  ([`src/desktop/index.ts`](src/desktop/index.ts),
  [`cache.ts`](../../../app/desktop/doric/src/platform/native/cache.ts),
  [Quarantine](../../../docs/architecture/bundles/core.md#quarantine)).
- When no active bundle provides `hooks/v1`, the bundle is quarantined and does
  not activate (`missing_dependency` or `dependency_quarantined`)
  ([Quarantine](../../../docs/architecture/bundles/core.md#quarantine)).
- In both cases `history.snapshots/v1` has no provider, so the chat opens every
  Thread from the host alone and draws it once the host answers
  ([`index.ts`](../chat/src/client/index.ts)).
- Updates absorbed and not yet written are lost when the generation process is
  lost, and in an older generation when the app exits before that generation's
  cleanup runs: only the timed write, the before-quit handler and deactivation
  write them ([`src/desktop/store.ts`](src/desktop/store.ts),
  [`main.ts`](../../../app/desktop/doric/src/main.ts)).
- The before-quit handler always allows the quit, even when a write fails
  ([`src/desktop/index.ts`](src/desktop/index.ts)).
- The bundle logs nothing.

## Build and test

```console
npx nx run bundle-history:typecheck
npx nx run bundle-history:test
npx nx run bundle-history:build
```

([`project.json`](project.json)). `build` compiles `src/` except the desktop
part with [`tsconfig.json`](tsconfig.json), which writes `dist/contracts/`, and
then runs the bundle build, which writes `dist/manifest.json`,
`dist/contracts.json`, `dist/package.json`, `dist/desktop/index.js` (the
bundled desktop part) and `dist/schemas/history.snapshots/v1.json`
([Build tooling](../../../packages/bundle/README.md#build-tooling)).
`typecheck` checks the same files, writing only their declarations into
`dist/`, and the desktop part, the latter with
[`tsconfig.parts.json`](tsconfig.parts.json) and no output. `test` builds the
bundle first, removes `dist-tests/`, compiles `src/` and `tests/` with
[`tsconfig.spec.json`](tsconfig.spec.json) into `dist-tests/`, and runs
`dist-tests/tests/*.test.js` with `node --test`.

The host's `doric-host:build-bundles` target stages every built bundle, this
one included, into `app/backend/doric-host/dist/bundles/`
([`app/backend/doric-host/project.json`](../../../app/backend/doric-host/project.json)).
The bundle runs because `history` is listed in `enabled` of the host's
composition
([`composition.json`](../../../app/backend/doric-host/composition.json)), and
the desktop receives it through the host's distribution
([Composition and distribution](../../../docs/architecture/bundles/composition-and-distribution.md)).

- [`tests/store.test.ts`](tests/store.test.ts) covers the store: the merge
  rule, the Thread record, rewind markers, a log a previous run cached, missing
  and corrupt files, eviction and deletion.
- [`tests/service.test.ts`](tests/service.test.ts) covers the contract through
  the built bundle, booted in one `desktopMain` environment by
  [`tests/support/desktop.ts`](tests/support/desktop.ts) with a test `hooks/v1`,
  a given storage identity and a temporary cache directory: reads before the
  disk, the file layout, the before-quit flush, a later run, another storage
  generation, and the disabled store.
