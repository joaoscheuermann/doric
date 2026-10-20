# Runtime bundle

`runtime` is the engine that keeps Doric's work running: it owns Projects and
their Threads, queues and runs each prompt through the executor, leases each
Project's sandbox, lets a Thread delegate to child Threads, and recovers its
work after a restart or an upgrade of the host's bundles.

It provides the runtime's contracts over stores built on `storage/v1`, and
publishes the `runtime/contracts` entrypoint that tools and feature bundles
use to reach a prompt's Thread, working directory and sandbox. See the
[main README](../../../README.md) for Doric as a whole and
[`packages/bundle`](../../../packages/bundle/README.md) for how bundles work.

## What it provides

- `runtime/v1` — Projects (create, read, rename, color, terminate, delete,
  activity), the runtime's watch streams, and the lifecycle methods recover,
  adopt and drain.
- `runtime.threads/v1` — the Thread model: create, read, rename, prompt,
  steer, resume, retry, rewind, compact, pause, terminate and delete Threads,
  manage their prompt queues, and watch a Thread. `instruct` (bundles only, never
  a window) gives a Thread a bundle's instruction: a steer whose source is
  `{ kind: 'bundle', bundleId, reason, retain? }`, with the calling bundle's
  own id; it reaches agent Threads too. `retain` marks a standing
  instruction, which the executor keeps through compaction. Its prompt-scoped members `spawn`,
  `list`, `get`, `events`, `send`, `interrupt` and `terminate` act on the
  calling prompt's direct children, through the `ThreadControl` type in
  `contracts/tool-host`; the [`threads`](../../features/threads/README.md)
  bundle exposes them as tools.
- `runtime.workspace/v1` — `cwd` and `setCwd` of the calling prompt's Thread,
  and `withThread`, which runs a task on one live Thread.
- `runtime.lease/v1` — `describe`, `exec`, `readFile` and `writeFile` on the
  sandbox leased to the calling prompt's Project (`exec` carries no abort
  signal and returns text only), lease reads that answer the lease state
  without acquiring one, and `withLease`, which runs a task on the sandbox the
  Project holds now.
- `runtime.terminals/v1` — a Project's terminal sessions, delegated to the
  [`terminal`](../../features/terminal/README.md) bundle while it is active.
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

Every method is scoped by the `Call` it receives. Record schemas are loose, so
records with more fields than the contract names travel unchanged.

### Thread kinds

A Thread records who opened it in `origin`. A Thread without one was opened by
the reader, so a workspace written before the field keeps every Thread it had.

The reader's own Threads — a main Thread at the Project root and the
sub-threads it is branched into — take prompts, steer, rewind, rename and
delete. An agent Thread is one the `thread-spawn` tool created: the reader may
watch it, pause it, continue a paused prompt and `retry` the last one, and the
host refuses the rest. `retry` is therefore its own method: it sends the
Thread's last prompt again, read from the Thread's own log, so a retry can never
become a way to prompt an agent Thread. The reader branches a main Thread in the
sidebar, and the host enforces the same tree: `create` answers `invalid_parent`
to a Thread the reader opens under anything but a main Thread, while an agent
may spawn under any Thread it is working in, as deep as the work goes. A
sub-thread is a branch already, so no surface offers a branch under it either.

## How it works

- **Prompts:** the runner executes each prompt through `executor/v1` (the
  [`default`](../default/README.md) bundle in the shipped host) with the
  runtime's `PromptSession`, and the executor's checkpoint patch marks the turn
  boundary. Only queue and state mutations take the Project lock.
- **Host facade:** each prompt gets a `Host`, whose types live in
  `contracts/tool-host`. It closes over the calling prompt's Project and
  Thread: `threads` reaches only that prompt's direct children, `workspace`
  reports and moves only its own Thread's working directory, and `terminals`
  starts tracked commands in the calling Thread's sandbox.
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
