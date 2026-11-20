# history

`history` keeps, on the desktop, a local snapshot of the durable event log of
each recently used Thread, so that a window can draw a conversation before the
host answers. The snapshot is a cache: the host's durable Thread events are the
only conversation history, and the window's live stream reconciles whatever the
cache showed. The flow across bundles is described in the feature docs
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
`history/contracts`. It runs in `desktopMain`; both methods have the exposure
`'desktop'`, so a window reaches them over the desktop bridge. Every value is
plain data.

### Types

The record schemas are loose (`z.looseObject`): they check only the fields the
cache reads and keep every other field as it arrived, so the bundle depends on
no runtime contract.

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
  lastSequence: number; // sequence of the last event, 0 without events
  events: ThreadEventRecord[]; // ascending by sequence, no duplicates
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

The schemas are exported as `threadRecordSchema`, `threadEventRecordSchema`,
`historySnapshotSchema`, `historyUpdateSchema` and `historyWriteSchema`; the
method specs as `historySnapshotsMethods`; the reference as
`HistorySnapshotsV1`, typed with the interface `HistorySnapshots`.

### Methods

| Method  | Input              | Output                    | Behavior                                                                                    |
| ------- | ------------------ | ------------------------- | ------------------------------------------------------------------------------------------- |
| `read`  | `threadId: string` | `HistorySnapshot \| null` | The Thread's snapshot, including updates not yet written to disk; `null` when there is none |
| `write` | `HistoryWrite`     | `void`                    | Absorbs each update for `threadId`, in order, and schedules a write; resolves at once       |

The platform validates the input and output against the method specs and
refuses a call that does not match with `invalid_input` (a `write` with one
malformed update absorbs none of its updates) or `invalid_output`
([`packages/bundle/src/runtime/dispatch.ts`](../../../packages/bundle/src/runtime/dispatch.ts)).
The methods themselves never reject
([`src/desktop/index.ts`](src/desktop/index.ts),
[`src/desktop/store.ts`](src/desktop/store.ts)).

### Who uses it

The [`chat`](../chat/README.md) bundle lists the contract under `optional`: a
Thread it opens starts from `read`, its watch resumes after `lastSequence`, and
it hands every batch it applied to `write`. Without this bundle the chat opens a
Thread from the host alone
([`threads-api.ts`](../chat/src/client/api/threads-api.ts),
[`thread-chats.ts`](../chat/src/client/domain/thread-chats.ts),
[`history.ts`](../chat/src/client/api/history.ts)).

## Contracts used

| Contract             | From                         | What for                                                                                                         |
| -------------------- | ---------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `doric.cache/v1`     | the platform                 | `directory()`: the bundle's own cache directory, the root of every file it writes                                |
| `doric.catalog/v1`   | the platform                 | `get().storage`: the host's storage identity `{ hostId, storageGeneration }`, which names the snapshot namespace |
| `hooks/v1`           | `core` (required)            | `use(AppHooksV1)`, to reach the app's hooks                                                                      |
| `doric.app.hooks/v1` | the platform, via `hooks/v1` | `onBeforeQuitHook`, to write pending snapshots before the app quits                                              |

([`src/desktop/index.ts`](src/desktop/index.ts); the hook is described in
[Hooks](../../../docs/architecture/bundles/hooks.md).)

## The desktop part

`activate` ([`src/desktop/index.ts`](src/desktop/index.ts)):

1. Reads the cache directory from `doric.cache/v1` and the storage identity
   from `doric.catalog/v1.get().storage`, once.
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

## Behavior of the store

All in [`src/desktop/store.ts`](src/desktop/store.ts).

### Opening

The store creates its directory (recursively) and indexes every `*.json` file
already there, as Threads not yet loaded, ordered by modification time, oldest
first, with ties broken by Thread id. The Thread id of a file is the decoded
file name without `.json`. A file whose name cannot be decoded or that cannot
be stat'ed is skipped; a directory that cannot be created or listed leaves the
index empty.

### Absorbing an update

`write({ threadId, updates })` absorbs each update in order:

- `deleted`: forgets the Thread named by the update's own `threadId` and
  deletes its file at once; `projectId` is not used.
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

A write runs 250 ms after the first update that scheduled it; updates absorbed
meanwhile join it. A write, the before-quit handler and deactivation all flush:
the pending timer is cancelled and every dirty entry is written. A file is
written to `<file>.tmp` and renamed over `<file>`. An entry whose write throws
stays dirty and is written again on the next flush.

## Data and persistence

| Aspect    | Value                                                                                                             |
| --------- | ----------------------------------------------------------------------------------------------------------------- |
| Location  | `<doric.cache/v1 directory>/<encodeURIComponent(hostId)>/<storageGeneration>/<encodeURIComponent(threadId)>.json` |
| One file  | one Thread                                                                                                        |
| Encoding  | UTF-8 JSON, written by `JSON.stringify`                                                                           |
| Temporary | `<file>.tmp`, renamed into place                                                                                  |

The shape of one file:

```ts
type SavedHistory = {
  threadId: string;
  thread: ThreadRecord | null;
  lastSequence: number; // sequence of the last event, 0 without events
  events: ThreadEventRecord[]; // ascending, deduplicated, rewinds applied
  savedAt: string; // ISO 8601 time of the write
};
```

`savedAt` is not read. A read requires `lastSequence` to be a number and
`threadId` to be a string but uses neither value: it computes `lastSequence`
from the events and answers for the Thread asked for. Because the namespace is
the host's `hostId` and `storageGeneration`, a different database or a reset
storage reads none of the snapshots another one left.

## Side effects

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

- At most 20 Threads are held. When an update brings a 21st, the least recently
  updated Thread is forgotten and its file deleted; files a previous run left
  count, in modification order, and the bound is enforced on the next update.
- A snapshot keeps the whole event log of its Thread, with no bound on the
  number of events.
- The storage identity is read once, at activation: when the catalog has none
  then, the store stays disabled until the bundle activates again.

## Errors and failure behavior

- No method of the store throws, and no failure reaches the caller: a file that
  cannot be read reads as `null`, a write that fails stays pending, a file that
  cannot be deleted stays until a later write replaces it, and a directory that
  cannot be indexed starts empty.
- The before-quit handler always allows the quit, even when a write fails.
- The bundle logs nothing.

## Build and test

```console
npx nx run bundle-history:typecheck
npx nx run bundle-history:test
npx nx run bundle-history:build
```

([`project.json`](project.json)). `build` compiles `src/` except the desktop
part with [`tsconfig.json`](tsconfig.json) and then runs the bundle build,
writing `dist/`. `typecheck` checks the same files, writing only their
declarations into `dist/`, and the desktop part, the latter with
[`tsconfig.parts.json`](tsconfig.parts.json) and no output. `test` builds the
bundle first, compiles `src/` and `tests/` with
[`tsconfig.spec.json`](tsconfig.spec.json) into `dist-tests/`, and runs
`dist-tests/tests/*.test.js` with `node --test`. The host's
`doric-host:build-bundles` target stages every built bundle, this one included,
into `app/backend/doric-host/dist/bundles/`
([`app/backend/doric-host/project.json`](../../../app/backend/doric-host/project.json)).

- [`tests/store.test.ts`](tests/store.test.ts) covers the store: the merge
  rule, the Thread record, rewind markers, a log a previous run cached, missing
  and corrupt files, eviction and deletion.
- [`tests/service.test.ts`](tests/service.test.ts) covers the contract through
  the built bundle, booted in one `desktopMain` environment by
  [`tests/support/desktop.ts`](tests/support/desktop.ts) with a test `hooks/v1`,
  a given storage identity and a temporary cache directory: reads before the
  disk, the file layout, the before-quit flush, a later run, another storage
  generation, and the disabled store.
