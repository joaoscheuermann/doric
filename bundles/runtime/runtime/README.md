# Runtime bundle

`runtime` is the engine that keeps Doric's work running: it owns Projects and
their Threads, queues and runs each prompt through the executor, leases each
Project's sandbox, lets a Thread delegate to child Threads, and recovers its
work after a restart or an upgrade of the host's bundles.

It provides the runtime's contracts over stores built on `storage/v1`, and
publishes the `runtime/contracts` entrypoint that tools and feature bundles
use to reach a prompt's Thread, working directory and sandbox. Its client part
activates in each desktop window and provides `runtime.records/v1`, the
window's records mirror, over `runtime/v2` and `runtime.threads/v1`. See the
[main README](../../../README.md) for Doric as a whole and
[`packages/bundle`](../../../packages/bundle/README.md) for how bundles work.

## What it provides

- `runtime/v2` 2.0.0 — Projects (create, read, rename, color, terminate,
  delete, activity), the runtime's watch streams, and the lifecycle methods
  recover, adopt and drain. The `snapshot` item of `watchProject` has no
  `terminals`; a Project's terminals are read from the
  [`terminal`](../../features/terminal/README.md) bundle's `terminal/v1`.
  Runtime 3.0.0 no longer provides the first version of the contract, whose
  snapshot carried them.
- `runtime.threads/v1` — the Thread model: create, read, rename, prompt,
  steer, resume, retry, rewind, compact, pause, terminate and delete Threads,
  manage their prompt queues, and watch a Thread. `instruct` (bundles only, never
  a window) gives a Thread a bundle's instruction: a steer whose source is
  `{ kind: 'bundle', bundleId, reason, retain? }`, with the calling bundle's
  own id; it reaches agent Threads too. `retain` marks a standing
  instruction, which the executor keeps through compaction.
  `setThreadExecution({ id, providerId, model, effort? })` (1.7.0) sets a
  Thread's provider, model and effort together, validated against the
  configuration in force and `models/v1.resolve`, and applies from the
  Thread's next run. 1.8.0 adds, exposed to the desktop only,
  `archiveThread({ id })` (archives the Thread and its idle, unpinned
  descendants as one batch; `archived` with the `batch`, or `missing`, `busy`,
  `already_archived`), `restoreThread({ id, batch? })` (`restored`, `missing`
  or `not_archived`), `setThreadPinned({ id, pinned })` and `viewThread`, a
  stream that holds a view of the Thread while open; `deleteThread` deletes an
  archived agent thread. An archiver sweeps the live Projects every 10 s and
  archives finished agent threads and inactive main threads under
  `threads.autoArchive`, never a busy, failed, reader-stopped
  (`result.reason: 'interrupted'`), waiting, viewed or pinned one; new
  activity un-archives a Thread. The fence and question-form rules
  (`hasQuestionForm`, `completedStatements`) are shared from
  `contracts/fences.ts` with `chat` and `openui`
  ([docs/features/thread-archive.md](../../../docs/features/thread-archive.md)).
  Its prompt-scoped members `spawn`,
  `list`, `get`, `events`, `send`, `restart`, `interrupt` and `terminate` act on the
  calling prompt's direct children, through the `ThreadControl` type in
  `contracts/tool-host`; the [`threads`](../../features/threads/README.md)
  bundle exposes them as tools. `spawn(prompt, title?, options?)` (1.6.0)
  takes strict, optional `options`: `agent`
  (`{ name, source: 'built-in' | 'workspace', instructions }`, the
  instructions at most 64 000 characters), `model` and `effort`.
- `runtime.workspace/v1` — `cwd`, `setCwd` and `location` (the directory and
  its repository hint, probed now; 1.2.0, see
  [docs/features/cwd-tool.md](../../../docs/features/cwd-tool.md)) of the
  calling prompt's Thread, and `withThread`, which runs a task on one live
  Thread.
- `runtime.lease/v1` — `describe`, `exec`, `readFile` and `writeFile` on the
  sandbox leased to the calling prompt's Project (`exec` carries no abort
  signal and returns text only), `ssh`, which answers the lease state without
  acquiring one, and `withLease`, which runs a task on the sandbox the Project
  holds now. 1.3.0 (runtime 3.0.0) drops the reads of files, changes,
  resources and Git: the [`files`](../../features/files/README.md),
  [`git`](../../features/git/README.md) and
  [`resources`](../../features/resources/README.md) bundles answer them over
  `withLease` and `runtime.workspace/v1.withThread`.
- `runtime.hooks/v1` — `onProjectReadyHook`, `onProjectClosingHook` and
  `onThreadsClosingHook`, which the runner awaits where it closes a Thread's
  terminals; `onPromptStartedHook` (the prompt, its source, the Thread's `cwd`
  and `cwdRepo`), awaited after `prompt.started` and before the executor runs;
  and `onThreadCwdChangedHook` (both `cwd` and `cwdRepo` values before and
  after, and the running `promptId`), awaited after any change and before a move
  answers its caller. Both run outside the Project lock, so a handler may call
  `runtime.threads/v1`; an instruction it gives is read at the run's next safe
  point.
- `runtime.usage/v1` — a Thread's stored usage projection.
- Storage and event types: `runtime.project/v1`, `runtime.thread/v1`,
  `runtime.history/v1`, `runtime.migration/v1` and the
  `runtime.prompt-finished/v1` event. Each Thread's events land in its
  `runtime.thread.events/{threadId}` stream.
- `runtime.records/v1` 1.0.0 (runtime 2.9.0) — the records mirror, provided
  by the runtime's client part (`src/client/`) in each desktop window. It owns
  the window's Projects and Threads: the reads (`projects`, `project`,
  `threads`, `thread`, `connection`, `subscribe`) answer from memory;
  `findThread` and `activity` each ask the host once; `follow` keeps a Project current through its watch, and
  `reload` always loads; the twelve writes (create, rename, color, terminate
  and delete a Project; create, rename, terminate, delete, archive, restore
  and pin a Thread) put the host's answer in the mirror before they resolve;
  `view` holds a Thread's presence while open. A failed read keeps the
  rejection object as its `error`. Consumers import its types,
  `threadSubtreeIds` and `runtimeRecordsService(records)` from
  `runtime/contracts`.
- `runtime/testing` — `createRecordsApi` and `createRecordsFake`, a fake of
  the records mirror for the tests of the bundles that read it, with
  `RecordsOperation` and `RecordsFakeOptions` (`pending` and `failing`). A
  fake read answers `ready` from its options, unless the operation is pending
  or failing; a failing read uses the code `unavailable`. A fake write changes
  the records and calls the subscribers.

Every method of the host contracts is scoped by the `Call` it receives;
`runtime.records/v1` lives in one window and ignores it. Record schemas are loose, so
records with more fields than the contract names travel unchanged.

### Thread kinds

A Thread records who opened it in `origin`. A Thread without one was opened by
the reader, so a workspace written before the field keeps every Thread it had.

The reader's own Threads — a main Thread at the Project root and the
sub-threads it is branched into — take prompts, steer, rewind, rename and
delete. An agent Thread is one the `thread-spawn` tool created: the reader may
watch it, pause it, continue a paused prompt, `retry` the last one, archive,
restore and pin it, and delete it once archived (`deleteThread` refuses a
non-archived agent Thread); the host refuses the rest. `retry` is therefore its own method: it sends the
Thread's last prompt again, read from the Thread's own log, so a retry can never
become a way to prompt an agent Thread. The reader branches a main Thread in the
sidebar, and the host enforces the same tree: `create` answers `invalid_parent`
to a Thread the reader opens under anything but a main Thread, while an agent
may spawn under any Thread it is working in, as deep as the work goes. A
sub-thread is a branch already, so no surface offers a branch under it either.

A spawned Thread keeps the `agent`, `providerId`, `model` and `effort` it was
spawned with in its `runtime.thread/v1` document (1.2.0; `agent`, `model`
and `effort` since 1.1.0). A child always runs on its parent's provider. A
child spawned without a `model` takes the parent's model and effort, with the
spawn's `effort` over it when given; a spawn naming the parent's own model
keeps the parent's effort the same way. A spawn naming another model takes
the given `effort`, or else the model's start effort. A legacy parent (no
`providerId`) passes on what it resolves to: the default's provider with its
own model and effort when set. The runtime validates the result against the
configuration in force and rejects a refused spawn with a `ContractError`
`invalid_execution` (`details.issue`: `provider`, `model` or `effort`); a
provider `models/v1.resolve` cannot resolve rejects with that error. The
`agent` is never inherited: a child spawned without one has none. The public
`Thread` shows `agent` as `{ name, source }`, `providerId`, `model` and
`effort`, and never the instructions: the runner reads them from
the stored document on every run and compaction and passes them to the
executor as `thread.agent.instructions`, so a retry, a parent's send, the
restart of a failed child and a run after a host restart all use the values
the Thread was spawned with. A document written before 1.1.0 has none of the
three. From `executor/v1` 1.3.0 the executor's `run` and `compact` receive
this Thread (`ExecutorThread`, checked by `executorThreadSchema`): its
`agent` with the instructions, its `model` and its `effort`. When the stored
document holds no instructions for an agent Thread, the runner drops `agent`
from what it passes, and the executor runs the Thread as the default agent.
The runtime requires `executor/v1@^1.4.0`: from 1.4.0 the executor runs and
compacts on the Thread's own provider, and an older executor would ignore it.

## How it works

- **Client part:** `src/client/` activates in each desktop window and
  provides `runtime.records/v1` over `runtime/v2` and `runtime.threads/v1`. It
  calls no host method at activation.
- **Prompts:** the runner executes each prompt through `executor/v1` (the
  [`default`](../default/README.md) bundle in the shipped host) with the
  runtime's `PromptSession`, and the executor's checkpoint patch marks the turn
  boundary. Only queue and state mutations take the Project lock.
- **Host facade:** each prompt gets a `Host`, whose types live in
  `contracts/tool-host`. It closes over the calling prompt's Project and
  Thread: `threads` reaches only that prompt's direct children, and
  `workspace` reports and moves only its own Thread's working directory.
  Tracked commands are the `terminal` bundle's `terminal/v1`.
- **Sandboxes:** Projects lease their sandbox through `sandbox/v1`; the
  runtime applies the stored Git identity and GitHub API token to the
  sandbox, so the agent's Git commands authenticate without credentials in
  tool arguments.
- **Start and stop:** activation does no data work. The start step reconciles
  the persisted Projects and Threads at the `workspace_reconciliation` stage;
  the stop step ends the running prompts before the other bundles deactivate.
- **Handover:** the runtime runs in every generation process. When the
  generation changes, the new one recovers while the old one drains its
  running prompts and releases each Project, which the active runtime then
  adopts.
- **Events:** what other bundles append to a Thread's log through `events/v1`
  is folded into the Thread and published as soon as it is committed.

## Development

```console
npx nx build bundle-runtime
npx nx typecheck bundle-runtime
npx nx test bundle-runtime
```

To rebuild and stage every bundle used by the Doric host:

```console
npx nx run doric-host:build-bundles
```
