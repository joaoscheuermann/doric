# Runtime bundle

`runtime` keeps Doric's work running. It owns Projects and their Threads, stores
them on `storage/v1`, queues each prompt and runs it through `executor/v1`,
leases each Project's sandbox through `sandbox/v1`, lets a running prompt
delegate to child Threads, archives finished Threads, and recovers its work after
a host restart or a change of bundle generation. Its client part keeps a mirror
of the Projects and Threads in every desktop window.

This README is the bundle's complete overview: its manifest, every contract it
provides or declares with its full shape, its data and storage, its behavior,
its configuration, limits and errors, and how to build and test it. See the
[main README](../../../README.md) for Doric as a whole,
[`packages/bundle`](../../../packages/bundle/README.md) for how bundles work, and
the feature docs [Projects and Threads](../../../docs/features/projects-and-threads.md),
[Stop, steering and the queue of inputs](../../../docs/features/prompt-control.md),
[Delegation](../../../docs/features/delegation.md),
[Default agent](../../../docs/features/default-agent.md),
[per-Thread model](../../../docs/features/per-thread-model.md),
[Context compaction](../../../docs/features/context-compaction.md),
[Attachments](../../../docs/features/attachments.md),
[Usage](../../../docs/features/usage.md),
[Sandboxes](../../../docs/features/sandboxes.md),
[Thread archive](../../../docs/features/thread-archive.md) and
[`cwd` tool](../../../docs/features/cwd-tool.md) for the flows that cross
bundles.

## Contents

- [Manifest](#manifest)
- [Parts and entry points](#parts-and-entry-points)
- [Records: Projects and Threads](#records-projects-and-threads)
- [Contracts it provides](#contracts-it-provides)
- [Contracts it declares for other providers](#contracts-it-declares-for-other-providers)
- [Other exports of `runtime/contracts`](#other-exports-of-runtimecontracts)
- [Contracts it uses](#contracts-it-uses)
- [Data and storage](#data-and-storage)
- [Behavior](#behavior)
- [Client part: the records mirror](#client-part-the-records-mirror)
- [Configuration](#configuration)
- [Limits](#limits)
- [Errors and failure behavior](#errors-and-failure-behavior)
- [Build and test](#build-and-test)

## Manifest

[`manifest.json`](manifest.json):

| Field             | Value                                                                                                                                                                                                                                                                                                                                                                                                      |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `manifestVersion` | `1`                                                                                                                                                                                                                                                                                                                                                                                                        |
| `id`              | `runtime`                                                                                                                                                                                                                                                                                                                                                                                                  |
| `version`         | `3.0.0`                                                                                                                                                                                                                                                                                                                                                                                                    |
| `engines.doric`   | `^1.0.0`                                                                                                                                                                                                                                                                                                                                                                                                   |
| `description`     | Project and Thread model, queue, recovery, delegation and lease coordination.                                                                                                                                                                                                                                                                                                                              |
| `provides`        | `runtime/v2@2.0.0`, `runtime.threads/v1@1.8.0`, `runtime.workspace/v1@1.2.0`, `runtime.lease/v1@1.3.0`, `runtime.attachments/v1@1.0.0`, `runtime.hooks/v1@1.2.0`, `runtime.usage/v1@1.0.0`, `runtime.records/v1@1.0.0`, `runtime.prompt-finished/v1@1.0.0`, `runtime.project/v1@1.1.0`, `runtime.thread/v1@1.3.0`, `runtime.history/v1@1.0.0`, `runtime.migration/v1@1.0.0`, `runtime.attachment/v1@1.0.0` |
| `requires`        | `storage/v1@^1.1.0`, `events/v1@^1.0.0`, `hooks/v1@^1.0.0`, `core.event-hooks/v1@^1.0.0`, `log/v1@^1.0.0`, `secrets/v1@^1.0.0`, `models/v1@^1.0.0`, `host-config/v1@^1.0.0`, `executor/v1@^1.4.0`, `sandbox/v1@^1.0.0`                                                                                                                                                                                     |
| `optional`        | none                                                                                                                                                                                                                                                                                                                                                                                                       |
| `desktopScope`    | `runtime/v2`, `runtime.threads/v1`, `runtime.lease/v1` and `runtime.attachments/v1` each take `projectId`, `threadId` and `promptId` from a window's call scope                                                                                                                                                                                                                                            |

Not every `provides` entry is a callable contract. `runtime.project/v1`,
`runtime.thread/v1`, `runtime.history/v1`, `runtime.attachment/v1` and
`runtime.migration/v1` are the storage types the bundle defines on
`storage/v1` ([Data and storage](#data-and-storage)).
`runtime.prompt-finished/v1` is an event it registers on `events/v1`
([`runtime.prompt-finished/v1`](#runtimeprompt-finishedv1)). `runtime.hooks/v1`
is a hook set it defines through `hooks/v1` (`define`) and fires
([`runtime.hooks/v1`](#runtimehooksv1), [`ports.ts`](src/host/ports.ts)).

`desktopScope` names the scope keys a window may send for each contract
([contexts](../../../docs/architecture/bundles/contexts.md)). No method of
`runtime.lease/v1` is exposed to the desktop, so its `desktopScope` entry is
never used ([`services/lease.ts`](src/host/services/lease.ts)).

The package is `runtime` ([`package.json`](package.json)). It exports
`runtime/contracts` ([`src/contracts/index.ts`](src/contracts/index.ts)) and
`runtime/testing` ([`src/testing.ts`](src/testing.ts)). `runtime/contracts` is
browser-safe: it holds contract refs, zod schemas, types and pure functions,
and imports only `zod` and `bundle/contracts` at run time; its imports from
`sandbox`, `sandpool` and `host-config/contracts` are type-only (the
configuration value types are re-exported from `host-config/contracts`,
[`configuration.ts`](src/contracts/configuration.ts)).

## Parts and entry points

| Part      | Entry                                              | What it does                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| --------- | -------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Host      | [`src/host/index.ts`](src/host/index.ts)           | Defines the storage types, registers the `runtime.prompt-finished/v1` event and the Thread event sink, builds the stores and the service, provides `runtime/v2`, `runtime.threads/v1`, `runtime.workspace/v1`, `runtime.usage/v1`, `runtime.lease/v1` and `runtime.attachments/v1`, defines `runtime.hooks/v1` through `hooks/v1` (`define`), observes `core.event-hooks/v1` through `hooks/v1` (`whenAvailable`) to fold the events other bundles append, and installs the start, stop and generation-handover hooks. Activation reads and writes no data. |
| Client    | [`src/client/index.ts`](src/client/index.ts)       | Provides `runtime.records/v1` in each desktop window over `runtime/v2`, `runtime.threads/v1` and `doric.connection/v1`. Activation calls no host method.                                                                                                                                                                                                                                                                                                                                                                                                    |
| Contracts | [`src/contracts/index.ts`](src/contracts/index.ts) | The contract refs, their zod schemas, the record types, and the pure rules shared with other bundles.                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Testing   | [`src/testing.ts`](src/testing.ts)                 | `createRecordsApi` and `createRecordsFake`, an in-memory `runtime.records/v1` for other bundles' tests.                                                                                                                                                                                                                                                                                                                                                                                                                                                     |

The host part is layered: `services/` maps each contract method to the domain
([`src/host/services/`](src/host/services/)); `domain/` holds the service, the
runner, the archiver, the lifecycle rules and the ports
([`src/host/domain/`](src/host/domain/)); `store/` holds the documents and
streams on `storage/v1` ([`src/host/store/`](src/host/store/));
[`ports.ts`](src/host/ports.ts) is the only file that reads `services` for the
domain. [`lifecycle.ts`](src/host/lifecycle.ts) and
[`handover.ts`](src/host/handover.ts) install the start, stop and generation
hooks; [`peers.ts`](src/host/peers.ts) declares the `core.event-hooks/v1` ref
and [`appends.ts`](src/host/appends.ts) folds each appended event into its
Thread.

## Records: Projects and Threads

The public records travel through every contract as loose zod objects, so a
record with more fields than its schema names validates and travels unchanged
([`model.ts`](src/contracts/model.ts)).

The host builds each public record from its stored document
([`runtime.project/v1`](#runtimeprojectv1),
[`runtime.thread/v1`](#runtimethreadv1)): a field stored as `null` is absent
from the record; a Project `color` outside the palette is dropped; a Thread's
`archive.at` becomes `archivedAt`, its `result` keeps only `status`, `text`,
`promptId` and `at` (the stored `reason` is dropped), its `agent` keeps only
`name` and `source`, and `executionStartedAt` and `lastExecutionMs` are
derived, not stored ([`store/projects.ts`](src/host/store/projects.ts),
[`store/threads.ts`](src/host/store/threads.ts),
[`store/records.ts`](src/host/store/records.ts)).

### Project

```ts
interface Project {
  id: string; // UUID
  name: string;
  color?: ProjectColor; // 'red' | 'orange' | 'amber' | 'green' | 'teal' | 'blue' | 'violet' | 'pink'
  state: ProjectState; // 'queued' | 'ready' | 'cancelling' | 'cancelled' | 'failed'
  configRevision: number; // the configuration revision in force at creation
  errorCode?: string;
  createdAt: string; // ISO 8601
  updatedAt: string;
  startedAt?: string; // first time it became ready
  finishedAt?: string; // when it became cancelled or failed
}
```

The states are written by
[`store/projects.ts`](src/host/store/projects.ts) and
[`service.ts`](src/host/domain/service.ts); the table gives their meanings, and
the transitions are described under [Behavior → Projects](#projects) and
[Recovery, host stop and handover](#recovery-host-stop-and-handover).

| Project state | Meaning                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `queued`      | Live, waiting for its sandbox lease. A new Project starts here. A restart's reconcile writes every open Project that is not `cancelling` back here and clears its `errorCode` ([`store/projects.ts`](src/host/store/projects.ts)); a `cancelling` one becomes `cancelled`. A host stop writes every live Project back here after releasing its lease, with `errorCode` `sandbox_release_failed` when the release failed ([`service.ts`](src/host/domain/service.ts)).                           |
| `ready`       | Its sandbox is leased; its Threads run.                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `cancelling`  | Its termination is in progress.                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `cancelled`   | Terminated. Terminal.                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `failed`      | Ended by a failure: `errorCode` is `sandbox_acquisition_failed` (acquiring the lease, applying its Git credentials, probing its Threads' directories, or recording the lease failed; recording writes the Project `ready`, resets each missing `cwd` and sets its Threads `ready`) or `sandbox_release_failed` (the lease could not be released when the Project ended, which takes precedence) ([`service.ts`](src/host/domain/service.ts); [Errors](#errors-and-failure-behavior)). Terminal. |

### Thread

```ts
interface Thread {
  id: string; // UUID
  projectId: string;
  parentThreadId?: string;
  origin?: 'user' | 'agent'; // absent: the reader's
  name: string;
  state: ThreadState; // ProjectState | 'running'
  lastSequence: number; // the last sequence of its event stream
  queuePaused?: boolean; // always present on host records, see below
  cwd: string; // absolute inside the sandbox
  cwdRepo?: 'git' | 'github'; // repository hint of cwd's own root
  activePromptId?: string;
  executionStartedAt?: string; // derived, see below
  lastExecutionMs?: number; // derived, see below
  errorCode?: string;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  finishedAt?: string;
  result?: { status: string; text: string; promptId: string; at: string };
  agent?: { name: string; source: 'built-in' | 'workspace' }; // never the instructions
  providerId?: string; // the Thread's execution, see Execution
  model?: string;
  effort?: ReasoningEffort; // 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'
  archivedAt?: string; // set while archived, see Archive
  pinned?: boolean; // the reader's pin, see Archive
}
```

`providerId`, `model` and `effort` are the Thread's own execution choice
([Execution: provider, model and effort](#execution-provider-model-and-effort));
`archivedAt` and `pinned` belong to the [Archive](#archive). `queuePaused` is
optional in the schema ([`model.ts`](src/contracts/model.ts)), but every
record the host builds carries it
([`store/threads.ts`](src/host/store/threads.ts),
[`service.ts`](src/host/domain/service.ts)).

The two execution times are derived when the record is built
([`store/threads.ts`](src/host/store/threads.ts)):

- `executionStartedAt` is present only while the Thread is `running` with an
  `activePromptId`. It is the time of the last `prompt.started` event when that
  event's prompt is the active one, else the Thread's `updatedAt`.
- `lastExecutionMs` is present only when `result.promptId` is the prompt of the
  last `prompt.started` event. It is `max(0, result.at − start)`, in
  milliseconds, where `start` is the time of that event.

The states are written by
[`store/threads.ts`](src/host/store/threads.ts),
[`runner.ts`](src/host/domain/runner.ts) and
[`service.ts`](src/host/domain/service.ts); the table gives their meanings, and
the transitions are described under [Behavior → Threads](#threads) and
[Recovery, host stop and handover](#recovery-host-stop-and-handover).

| Thread state | Meaning                                                                                                                                                                                                                                                                                                                       |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `queued`     | Created while its Project has no lease.                                                                                                                                                                                                                                                                                       |
| `ready`      | Idle, or waiting for its next queued prompt. A restart's recovery and a host stop also write each non-terminal, non-`cancelling` Thread `ready`, even while its Project has no lease ([`store/threads.ts`](src/host/store/threads.ts), [`runner.ts`](src/host/domain/runner.ts), [`service.ts`](src/host/domain/service.ts)). |
| `running`    | A prompt runs; `activePromptId` names it.                                                                                                                                                                                                                                                                                     |
| `cancelling` | Its termination is in progress.                                                                                                                                                                                                                                                                                               |
| `cancelled`  | Terminated. Terminal: nothing reopens it.                                                                                                                                                                                                                                                                                     |
| `failed`     | Closed by a failure (`errorCode`: `persistence_failed`, `terminal_result_failed`, or the Project's failure). Terminal; only `restart` of a direct child reopens it.                                                                                                                                                           |

`result` is the outcome of the Thread's most recent finished prompt; the last
finished prompt wins ([`runner.ts`](src/host/domain/runner.ts)).

**Thread kinds.** A Thread without `origin`, or with `origin: 'user'`, is the
reader's: a main Thread at the root of its tree, or a sub-thread the reader
branched from a main Thread. A Thread with `origin: 'agent'` was spawned by a
running prompt. On an agent Thread, exactly these calls answer `forbidden`:
`prompt`, `steer`, `rewind`, `editQueued`, `removeQueued`, and `deleteThread`
while the Thread is not archived. Every other call works on it as on a
reader's Thread: among them `watchThread` and `viewThread`, `renameThread`,
`setThreadCwd`, `setThreadExecution`, `pause`, `resumeQueue`, `resume`,
`retry`, `compact`, `instruct`, `terminateThread`, `archiveThread`,
`restoreThread` and `setThreadPinned`
([`service.ts`](src/host/domain/service.ts)).

`createThread` creates a reader's Thread
([`service.ts`](src/host/domain/service.ts),
[`runner.ts`](src/host/domain/runner.ts)). It answers `missing` when the
Project does not exist; `inactive` when the Project is not live here or is
closing, or when the parent is closing; and `invalid_parent` when the parent is
not a Thread the Project holds here, or is not a main Thread. A running
prompt's `spawn` creates an agent Thread under the calling Thread through the
same steps, so an agent Thread may nest at any depth; there any answer other
than `created` makes `spawn` throw `Error('Thread cannot be created.')`
([`runtime.threads/v1`](#runtimethreadsv1)). After those checks the store reads the
stored documents and rejects the call, rather than answering a status, in two
cases ([`store/threads.ts`](src/host/store/threads.ts)):
`Error('Inactive project.')` when the Project document is neither `queued` nor
`ready`, and `Error('Invalid parent thread.')` when an ancestor is missing,
belongs to another Project, or is `cancelling`, `failed` or `cancelled`. The
ancestor case occurs: a Thread closed by `persistence_failed` or
`terminal_result_failed` closes only itself, so its children stay live, and a
spawn from one of them rejects with that error.

Other record types of [`model.ts`](src/contracts/model.ts):

```ts
type InputSource =
  | { kind: 'user' }
  | { kind: 'terminal'; terminalId: string; promptId: string }
  | { kind: 'parent'; threadId: string; promptId: string }
  | {
      kind: 'result';
      threadId: string;
      promptId: string;
      requestPromptId: string;
    }
  | { kind: 'bundle'; bundleId: string; reason: string; retain?: true };
```

`InputSource` says where an accepted input comes from
([Prompts and the queue](#prompts-and-the-queue)): `user` is the reader's own
input; `terminal` is a background terminal's result, `terminalId` naming the
terminal and `promptId` the prompt it belongs to; `parent` is a task a parent
Thread gives its child through `spawn`, `send` or `restart`, naming the
parent and its calling prompt; `result` is a child's result delivered to its
parent, naming the child, the child's prompt and the parent prompt that asked
for it (`requestPromptId`); `bundle` is an instruction a bundle sends through
`instruct`, naming the calling bundle and its `reason`, with `retain: true` for
a standing instruction ([`runtime.threads/v1`](#runtimethreadsv1),
[`prompts.ts`](src/host/domain/prompts.ts)).

```ts
interface ThreadEvent {
  projectId: string;
  threadId: string;
  promptId: string;
  sequence: number;
  type: string;
  event: unknown;
  createdAt: string;
}

interface Page<V> {
  items: readonly V[];
  nextCursor?: string;
}

interface QueueItem {
  promptId: string;
  source: InputSource;
  label: string; // by source kind, see below
  preview: string; // the text (or a terminal's `Command:` line), whitespace collapsed, at most 240 characters
  acceptedAt: string; // the accept event's time, '' when unknown
  editable: boolean;
  revision: number; // the sequence of its accept or last edit event, 0 when unknown
}
interface QueuedPrompt {
  promptId: string;
  text: string;
  revision: number;
  editable: boolean;
}
interface ThreadQueue {
  error?: { code: string; message: string }; // { code: 'storage_low', message: storageMessage }
  revision: number; // the Thread's lastSequence
  paused: boolean;
  stopping: boolean;
  current?: QueueItem;
  resumable?: QueueItem;
  items: readonly QueueItem[];
}
```

The queue snapshot is built by [`store/queue.ts`](src/host/store/queue.ts):

- A `QueueItem`'s `label` follows its source kind: `user` gives `You`,
  `terminal` gives `Terminal`, `bundle` gives `<bundleId> · <reason>`, `result`
  gives `Subthread · <name>` and `parent` gives `Parent · <name>`, where
  `<name>` is the other Thread's name, or the first 8 characters of its id
  when its name is unknown. `acceptedAt` is `''` and `revision` is `0` when the
  prompt's progress carries none ([`store/progress.ts`](src/host/store/progress.ts)).
- `paused` is the Thread's `queuePaused` while the Thread is neither terminal
  nor `cancelling`. `stopping` is `queuePaused` while the Thread is neither
  terminal nor `cancelling` and has an `activePromptId`: the queue is paused
  and the aborted running prompt has not ended yet. `error` is present only when such a
  Thread's `errorCode` is `storage_low`. A terminal or `cancelling` Thread has
  no `current`, no `resumable` and no `items`
  ([Prompts and the queue](#prompts-and-the-queue)).

```ts
interface UsageTotals {
  calls: number;
  unpricedCalls: number;
  cost: number;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  reasoningTokens: number;
}
interface ContextUsage {
  model: string;
  providerId?: string;
  contextWindowSource?: 'catalog';
  contextWindow?: number;
  inputTokens?: number;
}
interface ThreadUsage {
  context?: ContextUsage;
  total: UsageTotals; // the Thread and its descendants
  threads: (UsageTotals & {
    threadId: string;
    name: string;
    parentThreadId?: string;
  })[];
}

type ProjectSsh =
  | { status: 'missing' | 'pending' | 'unavailable' | 'expired' }
  | { status: 'ready'; vmId: string; ssh: SandboxSshAccess };
interface SandboxSshAccess {
  // from the `sandbox` package
  host: string;
  port: number;
  username: 'root';
  privateKey: string;
  knownHosts: string;
  hostKeyFingerprint: string;
}
```

`ProjectSsh` is what `ssh` on `runtime.lease/v1` answers, with its statuses
explained there ([`runtime.lease/v1`](#runtimeleasev1),
[`service.ts`](src/host/domain/service.ts)).
`SandboxSshAccess` is the leased sandbox's own SSH access, passed through
unchanged; the `sandbox` package defines it
([`packages/sandbox`](../../../packages/sandbox/README.md#implementing-a-provider),
[`model.ts`](src/contracts/model.ts)).

`Terminal`, `TerminalOutput` and `TerminalSnapshot` are exported with their
schemas, but this bundle produces none of them: `Terminal` and
`TerminalOutput` appear only as the `terminalUpdated` and `terminalOutput`
variants of `RuntimeNotice` on [`runtime/v2`](#runtimev2)
([`runtime.ts`](src/contracts/runtime.ts)),
which nothing in this bundle publishes
([`notices.ts`](src/host/domain/notices.ts)), and `TerminalSnapshot` appears in
no contract. The terminal bundle carries its own types in
`terminal/contracts`.

```ts
interface Terminal {
  id: string;
  projectId: string;
  threadId: string;
  origin: 'agent' | 'user';
  command: string;
  cwd: string;
  startedAt: string;
  timeoutMs: number | null;
  state: 'starting' | 'running' | 'exited';
  pty: boolean;
}
interface TerminalOutput {
  projectId: string;
  threadId: string;
  terminalId: string;
  data: string;
  offset: number;
}
interface TerminalSnapshot {
  terminal: Terminal;
  output: string;
  offset: number;
  truncated: boolean;
}
```

The result unions of the Thread operations are listed with
[`runtime.threads/v1`](#runtimethreadsv1).

## Contracts it provides

Every host method takes an optional last argument `call` (`CallArg` of
`bundle/contracts`). Prompt-scoped, lease and attachment methods read
`call.scope` through `readRuntimeScope` ([`scope.ts`](src/contracts/scope.ts),
[`services/lease.ts`](src/host/services/lease.ts),
[`services/attachments.ts`](src/host/services/attachments.ts)); `instruct`
reads `call.caller`; the others ignore `call`. A method marked _desktop_ is exposed to desktop windows
(`expose: 'desktop'`); every other method is callable by bundles only.

Every object input in this section is strict, nested objects such as
`SpawnOptions.agent` included: an unknown key fails input validation. The records and results the methods answer are loose, so a field
the schema does not name still travels. These outputs are strict: the item
envelopes of the watches, of `viewThread` and of `RecordsRead`, the `exec`
result of `runtime.lease/v1`, the `Attachment` and `AttachmentContent` of
`runtime.attachments/v1`, and the `archiveThread` answer of
`runtime.records/v1` ([`src/contracts`](src/contracts)).

A member marked "(local)" or "(local callback)" takes or answers a
process-local value, marked `x-doric-local` in its schema. A `callback` value
(the listeners of `drain` and `watch`, the tasks of `withThread` and
`withLease`) crosses a process boundary as a handle that its own process runs;
an `object` value (the outcomes of `withThread` and `withLease`) crosses as a
handle that only the runtime's process unwraps, so a caller in another process
cannot read it. The rules are in
[Contracts: services and methods](../../../docs/architecture/bundles/contracts.md#services-and-methods)
and [Process isolation: the envelope](../../../docs/architecture/bundles/process-isolation.md#the-envelope)
([`runtime.ts`](src/contracts/runtime.ts), [`workspace.ts`](src/contracts/workspace.ts),
[`lease.ts`](src/contracts/lease.ts)).

### `runtime/v2`

Projects, recovery, host stop and the runtime's notices
([`runtime.ts`](src/contracts/runtime.ts),
[`services/runtime.ts`](src/host/services/runtime.ts)).

| Method                       | Input                                                     | Output                                              | Notes                                                                                            |
| ---------------------------- | --------------------------------------------------------- | --------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `recover`                    | none                                                      | `RecoverySummary`                                   | Once per process; shares one summary with `recoverWith` (see below).                             |
| `recoverWith`                | `Handover`                                                | `RecoverySummary`                                   | `recover` while other runtime processes are alive (see below).                                   |
| `adopt`                      | `Handover`                                                | `void`                                              | Takes up standby Projects whose owner is gone; always resolves (see below).                      |
| `drain`                      | `ReleasedListener` (local callback)                       | `void`                                              | Lets every Project go; calls the listener once per released Project.                             |
| `dispose`                    | none                                                      | `void`                                              | Host stop; idempotent.                                                                           |
| `createProject` _desktop_    | `{ name }`                                                | `Project`                                           | Rejects with `Error('Doric is shutting down.')` after `dispose`.                                 |
| `project`                    | `id`                                                      | `Project \| undefined`                              |                                                                                                  |
| `projects` _desktop_         | `{ limit, cursor? }`                                      | `Page<Project>`                                     | Newest first.                                                                                    |
| `projectActivity` _desktop_  | none                                                      | `ProjectActivity[]`                                 |                                                                                                  |
| `renameProject` _desktop_    | `{ id, name }`                                            | `Project \| undefined`                              |                                                                                                  |
| `setProjectColor` _desktop_  | `{ id, color: ProjectColor \| null }`                     | `Project \| undefined`                              | `null` removes the color.                                                                        |
| `terminateProject` _desktop_ | `id`                                                      | `Project \| undefined`                              |                                                                                                  |
| `deleteProject` _desktop_    | `id`                                                      | `'deleted' \| 'active' \| 'missing' \| 'forbidden'` | Rejects with the storage backend's `limit_exceeded` when the deletion is larger than one commit. |
| `vmSsh`                      | `vmId`                                                    | `{ projectId, ssh } \| undefined`                   | The live Project whose lease holds that VM (see below).                                          |
| `watch`                      | `RuntimeListener` (local callback)                        | `Disposable`                                        | Every notice, in publication order, after its commit.                                            |
| `watchProject` _desktop_     | `[{ projectId: uuid }, StreamListener<ProjectWatchItem>]` | `Disposable`                                        | See [watches](#watches).                                                                         |

```ts
interface RecoverySummary {
  interruptedThreads: number;
  interruptedProjects: number;
  resumedPrompts: number;
}
interface RuntimeOwner {
  generation: number;
  incarnation: number;
} // integers
interface Handover {
  live: readonly RuntimeOwner[];
}
type ReleasedListener = (projectId: string) => void;
interface VmSsh {
  projectId: string;
  ssh: SandboxSshAccess;
}
interface ProjectActivity {
  project: Project;
  activityAt: string;
  latestActiveThreadId?: string;
}

type RuntimeNotice =
  | { kind: 'event'; value: ThreadEvent }
  | { kind: 'threadUpdated'; value: Thread }
  | { kind: 'threadDeleted'; projectId: string; threadId: string }
  | { kind: 'projectUpdated'; value: Project }
  | { kind: 'projectDeleted'; projectId: string }
  | { kind: 'terminalUpdated'; value: Terminal }
  | { kind: 'terminalOutput'; value: TerminalOutput }
  | {
      kind: 'terminalRemoved';
      projectId: string;
      threadId: string;
      terminalId: string;
    };
```

The runtime publishes the `event`, `thread*` and `project*` notices; it
publishes none of the `terminal*` kinds
([`notices.ts`](src/host/domain/notices.ts)). The `x-doric-local` marker is
`LOCAL_KEY` in [`runtime.ts`](src/contracts/runtime.ts).

`ProjectActivity` ([`activity.ts`](src/host/domain/activity.ts)):
`activityAt` is the latest `updatedAt` of the Project and all its Threads;
`latestActiveThreadId` is the non-terminal Thread with the latest `updatedAt`
(ties by id, ascending). The list covers every stored Project, terminal ones
included, and is sorted by `activityAt` descending, then Project id ascending
([`service.ts`](src/host/domain/service.ts)).

`recover` and `recoverWith` share one cached promise: whichever runs first
decides, and every later call of either answers the same outcome and ignores
its `Handover`. `adopt` calls run one at a time; each waits for a recovery already
started, then takes up the standby Projects. `adopt` always resolves: a
failure is only logged as `Project adoption failed`
([`lifecycle.ts`](src/host/lifecycle.ts)).

`deleteProject` never answers `forbidden`; the result type is the one
`deleteThread` shares. `vmSsh` answers `undefined` when no Project that is not
closing holds a lease on that VM, or when that Project's `ssh` is not `ready`
([`service.ts`](src/host/domain/service.ts)).

### `runtime.threads/v1`

The Thread model, its queue, its watches, and the controls a running prompt has
over its direct children ([`threads.ts`](src/contracts/threads.ts),
[`services/threads.ts`](src/host/services/threads.ts)).

**Prompt-scoped controls** (`RuntimeThreadControls`; bundles only). Each is
bound to the prompt that `call.scope` names (`projectId`, `threadId`,
`promptId`) and to direct children of that prompt's Thread in its Project. Once
the prompt's binding ended, or for a scope that names another Thread or Project,
every method rejects with `Error('Thread control is no longer active.')`
([`bindings.ts`](src/host/domain/bindings.ts)). While the binding still exists,
every method rejects with the same error when the Project or the calling Thread
is closing, or when the calling prompt has finished or been aborted; the one
exception is `restart` on a closing Project, which answers
`{ status: 'inactive' }`. A `threadId` that names no stored Thread, or a Thread
that is not a direct child, rejects with `Error('Thread is not a direct child.')`;
no control answers `missing` for it ([`runner.ts`](src/host/domain/runner.ts)).

| Method      | Input                                      | Output                                                              |
| ----------- | ------------------------------------------ | ------------------------------------------------------------------- |
| `spawn`     | `[prompt, title?, options?: SpawnOptions]` | `{ threadId, promptId }`                                            |
| `list`      | `[limit, cursor?]`                         | `ThreadPage` (`{ items: ThreadView[]; nextCursor? }`, newest first) |
| `get`       | `threadId`                                 | `ThreadSummary` (`{ thread: ThreadView; result?: ThreadResult }`)   |
| `events`    | `[threadId, afterSequence, limit]`         | `ThreadEventsPage` (`{ events: ThreadEventView[]; nextSequence? }`) |
| `send`      | `[threadId, prompt]`                       | `PromptResult`                                                      |
| `restart`   | `[threadId, prompt?]`                      | `RestartResult`                                                     |
| `interrupt` | `[threadId, promptId]`                     | `InterruptResult`                                                   |
| `terminate` | `threadId`                                 | `ThreadView`                                                        |

```ts
interface ThreadView {
  // the fields the controls guarantee
  id: string;
  projectId: string;
  parentThreadId?: string;
  name: string;
  state: string;
  lastSequence: number;
  activePromptId?: string;
  errorCode?: string;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  finishedAt?: string;
}
interface ThreadEventView {
  projectId: string;
  threadId: string;
  promptId: string;
  sequence: number;
  type: string;
  event: unknown;
  createdAt: string;
}
interface ThreadResult {
  status: string;
  text: string;
  promptId: string;
  at: string;
}

interface SpawnOptions {
  agent?: {
    name: string;
    source: 'built-in' | 'workspace';
    instructions: string;
  }; // instructions ≤ 64 000 characters
  model?: string;
  effort?: ReasoningEffort;
}

type PromptResult =
  | { status: 'accepted'; promptId: string }
  | { status: 'missing' | 'inactive' | 'forbidden' };
type RestartResult =
  | { status: 'accepted'; promptId: string }
  | {
      status:
        | 'missing'
        | 'inactive'
        | 'not_failed'
        | 'terminated'
        | 'no_prompt';
    };
type InterruptResult = 'interrupted' | 'missing' | 'inactive' | 'not_running';
```

`ThreadView` and `ThreadEventView` name the fields the controls guarantee. The
schemas are loose: `list`, `get` and `terminate` return the whole stored
`Thread` record, and `events` the whole `ThreadEvent`, so every other field
travels too ([`threads.ts`](src/contracts/threads.ts),
[`runner.ts`](src/host/domain/runner.ts)). All controls below are implemented
in [`runner.ts`](src/host/domain/runner.ts).

- `spawn` rejects with a `TypeError` on an empty prompt or an empty `title`;
  with `ContractError('invalid_execution', …)` when the spawn's `model` or
  `effort` is refused, or with the `models/v1.resolve` rejection passed through,
  both by the [spawn rules](#execution-provider-model-and-effort); with
  `Error('Thread cannot be created.')` when the Project cannot take the child;
  and with `Error('Thread cannot accept a task.')` when the child cannot take
  its first prompt. The child is named by `nameFromPrompt(title ?? prompt)` (see
  [Other exports](#other-exports-of-runtimecontracts)), gets `origin: 'agent'`
  and the spawn's `agent`, and its first prompt has the source
  `{ kind: 'parent', threadId, promptId }` of the calling prompt. Its execution
  follows the spawn rules. The empty-prompt and empty-title `TypeError`s, a
  closed binding, and a configuration or validation refusal reject before
  anything is stored. `Error('Thread cannot be created.')` stores nothing.
  `Error('Thread cannot accept a task.')`, a rejection of the child's `ready`
  state write, or a storage or redaction rejection while its first prompt is
  accepted, rejects after the child Thread is stored; that child stays, with no
  prompt queued.
- `list` answers the direct children, newest first, by the
  [Lists](#projects) rules: a `limit` that is not a positive safe integer
  throws `TypeError('Invalid page limit.')`; `nextCursor` is present only when
  another page exists, and is then the id of the last item; a cursor that names
  no Thread, or no direct child, answers an empty page
  ([`store/threads.ts`](src/host/store/threads.ts)).
- `events` answers the child's events whose sequence is greater than
  `afterSequence` (exclusive), at most `limit`; a `limit` that is not a positive
  safe integer throws `TypeError('Invalid page limit.')`. `nextSequence` is
  present only when more events exist, and is then the sequence of the last
  event returned ([`store/events.ts`](src/host/store/events.ts),
  [`store/records.ts`](src/host/store/records.ts)).
- `send` queues `prompt` on the child with the parent source. It answers
  `accepted`, or `inactive` when the child has no live runtime, the Project or
  the child is closing, or the child is terminal; it throws
  `TypeError('A non-empty prompt is required.')` on an empty prompt. It never
  answers `missing` or `forbidden`.
- `restart` reopens a direct child whose state is `failed` and queues `prompt`,
  or the child's last accepted prompt. It throws a `TypeError` on an empty
  `prompt`. Outside the Project lock it first waits for a closing child to
  finish closing. It then answers `terminated` for a `cancelled` child,
  `inactive` for a `cancelling` one, `not_failed` for any state other than
  `failed`, `inactive` when the Project is closing, and `no_prompt` when there
  is no text to send. It reopens the record: `missing` when the reopen finds no
  record, `not_failed` when the reopened state is not `ready`, and `inactive`
  when the child has no live runtime; in that last case the reopen is already
  written, so the stored child is `ready`, and it is not published. Otherwise
  it publishes the reopened record, then queues the text as `send` does
  ([`store/threads.ts`](src/host/store/threads.ts)).
- `interrupt` aborts the child's running prompt `promptId` and answers
  `interrupted`. It answers `inactive` when the child is closing or has no live
  runtime, and `not_running` when the child runs another prompt or `promptId`
  already finished. The prompt finishes `cancelled` with the text
  `The prompt was cancelled.`, and the child's queue goes on with its next
  prompt.
- `terminate` closes the child and its descendants and answers the child's
  record.

**Thread operations** (`RuntimeThreads`):

| Method                         | Input                                                                                   | Output                                                                                                  |
| ------------------------------ | --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `createThread` _desktop_       | `{ projectId, name, parentThreadId? }`                                                  | `ThreadCreateResult`                                                                                    |
| `thread` _desktop_             | `id`                                                                                    | `Thread \| undefined` (with the storage-pause overlay)                                                  |
| `storedThread`                 | `id`                                                                                    | `Thread \| undefined` (the stored record)                                                               |
| `threads` _desktop_            | `{ projectId, limit, cursor?, parentThreadId? }`                                        | `Page<Thread> \| undefined` (newest first; `undefined` for a missing Project)                           |
| `projectThreads`               | `projectId`                                                                             | `Thread[]` (`createdAt`, then id, ascending)                                                            |
| `renameThread` _desktop_       | `{ id, name }`                                                                          | `Thread \| undefined`                                                                                   |
| `setThreadCwd` _desktop_       | `{ id, cwd }`                                                                           | `CwdResult`; rejects when a sandbox command of the move throws                                          |
| `setThreadExecution` _desktop_ | `{ id, providerId (trimmed, 1–128), model (trimmed, 1–512), effort?: ReasoningEffort }` | `ThreadExecutionResult`                                                                                 |
| `archiveThread` _desktop_      | `{ id: uuid }`                                                                          | `ArchiveThreadResult`; rejects with `limit_exceeded` over the batch limit                               |
| `restoreThread` _desktop_      | `{ id: uuid, batch?: uuid }`                                                            | `RestoreThreadResult`; rejects with `limit_exceeded` over the batch limit                               |
| `setThreadPinned` _desktop_    | `{ id: uuid, pinned }`                                                                  | `Thread \| undefined`                                                                                   |
| `prompt` _desktop_             | `{ id, prompt }`                                                                        | `PromptResult`                                                                                          |
| `retry` _desktop_              | `{ id }`                                                                                | `PromptResult`                                                                                          |
| `steer` _desktop_              | `{ id, prompt, promptId, interrupt? }`                                                  | `SteerResult`                                                                                           |
| `instruct`                     | `{ id, prompt (≥ 1), reason (1–64), promptId?, interrupt?, retain? }`                   | `SteerResult`                                                                                           |
| `resume` _desktop_             | `{ id, promptId }`                                                                      | `ResumeResult`                                                                                          |
| `rewind` _desktop_             | `{ id, promptId, prompt }`                                                              | `RewindResult`                                                                                          |
| `compact` _desktop_            | `{ id }`                                                                                | `CompactResult`                                                                                         |
| `threadEvents`                 | `{ id, afterSequence }`                                                                 | `{ events: ThreadEvent[]; lastSequence } \| undefined`                                                  |
| `storedEventsAfter`            | `{ id, afterSequence }`                                                                 | `ThreadEvent[]` (no record check)                                                                       |
| `pause` _desktop_              | `{ id, promptId }` (`promptId` is ignored)                                              | `InterruptResult`                                                                                       |
| `terminateThread` _desktop_    | `id`                                                                                    | `Thread \| undefined`                                                                                   |
| `deleteThread` _desktop_       | `id`                                                                                    | `'deleted' \| 'active' \| 'missing' \| 'forbidden'`; rejects with `limit_exceeded` over the batch limit |
| `queue` _desktop_              | `id`                                                                                    | `ThreadQueue \| undefined`                                                                              |
| `resumeQueue` _desktop_        | `id`                                                                                    | `ResumeResult`                                                                                          |
| `queuedPrompt` _desktop_       | `{ id, promptId }`                                                                      | `QueuedPrompt \| undefined`                                                                             |
| `editQueued` _desktop_         | `{ id, promptId, text, revision }`                                                      | `EditQueueResult`                                                                                       |
| `removeQueued` _desktop_       | `{ id, promptId }`                                                                      | `RemoveQueuedResult`                                                                                    |
| `usage` _desktop_              | `id`                                                                                    | `ThreadUsage \| undefined` (with the context capacity fill)                                             |
| `enqueueTerminalResult`        | `{ threadId, promptId, terminalId, text }`                                              | `void`                                                                                                  |
| `failTerminalResult`           | `{ threadId }`                                                                          | `void`                                                                                                  |
| `watchThread` _desktop_        | `[{ threadId: uuid, afterSequence: int ≥ 0 }, StreamListener<ThreadWatchItem>]`         | `Disposable`                                                                                            |
| `viewThread` _desktop_         | `[{ threadId: uuid }, StreamListener<{ kind: 'viewing'; threadId }>]`                   | `Disposable`                                                                                            |

```ts
type ThreadCreateResult =
  | { status: 'created'; thread: Thread }
  | { status: 'missing' | 'inactive' | 'invalid_parent' };
type SteerResult =
  | { status: 'steered' | 'queued'; promptId: string }
  | { status: 'missing' | 'inactive' | 'forbidden' };
type ResumeResult =
  | { status: 'resumed'; thread: Thread }
  | {
      status:
        | 'missing'
        | 'inactive'
        | 'busy'
        | 'unknown_prompt'
        | 'storage_low';
    };
type RewindResult =
  | { status: 'accepted'; promptId: string }
  | {
      status: 'missing' | 'inactive' | 'busy' | 'unknown_prompt' | 'forbidden';
    };
type CompactResult =
  | {
      status: 'compacted';
      condensedMessages: number;
      retainedMessages: number;
      tokensFreed: number;
    } // tokensFreed is an estimate
  | {
      status: 'refused';
      reason: 'disabled' | 'missing_history' | 'nothing_to_compact';
    }
  | { status: 'failed'; code: 'summarizer_failed' | 'unsafe_boundary' }
  | { status: 'missing' | 'inactive' | 'busy' | 'not_supported' };
type CwdResult =
  | { status: 'updated'; thread: Thread }
  | { status: 'missing' }
  | { status: 'inactive' }
  | {
      status: 'refused';
      change: { status: 'outside' | 'missing' | 'not-directory' };
    };
type ThreadExecutionResult =
  | { status: 'updated'; thread: Thread }
  | { status: 'missing' }
  | { status: 'invalid'; reason: 'provider' | 'model' | 'effort' }
  | { status: 'unresolvable'; message: string };
type ArchiveThreadResult =
  | { status: 'archived'; batch: string; threads: Thread[] } // target first
  | { status: 'missing' | 'busy' | 'already_archived' };
type RestoreThreadResult =
  | { status: 'restored'; threads: Thread[] }
  | { status: 'missing' | 'not_archived' };
type EditQueueResult =
  | { status: 'updated'; prompt: QueuedPrompt }
  | {
      status:
        | 'missing'
        | 'inactive'
        | 'unknown_prompt'
        | 'not_editable'
        | 'conflict'
        | 'forbidden'
        | 'invalid_prompt';
    };
type RemoveQueuedResult =
  | 'removed'
  | 'missing'
  | 'inactive'
  | 'busy'
  | 'unknown_prompt'
  | 'forbidden';
```

`thread` adds the storage-pause overlay of
[Storage pressure](#storage-pressure); `usage` adds the context capacity fill
of [Usage](#usage). `threadEvents` answers every event after `afterSequence`,
with no limit, and `lastSequence` is the larger of the record's `lastSequence`
and the last event's sequence ([`service.ts`](src/host/domain/service.ts)).

`instruct` gives a Thread an instruction from the calling bundle: a steer whose
source is `{ kind: 'bundle', bundleId, reason, retain? }`, where `bundleId` is
the caller's own bundle id (`call.caller.bundleId`), never a value the caller
supplies. It reaches agent Threads too. `retain: true` marks a standing
instruction, which the executor keeps through compaction, one per bundle and
reason ([`services/threads.ts`](src/host/services/threads.ts),
[`service.ts`](src/host/domain/service.ts)).

`viewThread` holds a view of the Thread while its stream is open; a viewed
Thread is never archived on its own. Once the view is held the stream emits one
`{ kind: 'viewing', threadId }` and nothing else. It ends when disposed, when the
host link closes, with `ContractError('not_found', 'Thread not found.')` for a
missing Thread, with `ContractError('unavailable')` when the runtime drains,
and with `ContractError('internal', 'Thread view failed.')` when reading the
Thread fails, which logs `Thread view failed` at warn level with the
`threadId` and `error: String(error)`. Each
stream holds its own view; a stream ended with `not_found`, `unavailable` or
`internal` holds none ([`service.ts`](src/host/domain/service.ts),
[`archiver.ts`](src/host/domain/archiver.ts)).

#### Watches

`watchThread` and `watchProject` subscribe to the runtime's notices first, then
read the durable snapshot; what arrives in between is buffered, and Thread
events are deduplicated against the replay and delivered without gaps, each
sequence once. An event that arrives after a gap is held until the missing
sequence arrives; nothing is re-read from storage. A snapshot that cannot be
read ends the stream with
`ContractError('replay_failed', 'The snapshot could not be loaded.')`; that,
and the caller's dispose, are the only ends: `deleted`, `project-deleted` or an
unknown Thread leave the stream open. A listener's rejection is dropped, and a
listener that throws is swallowed the same way
([`services/watches.ts`](src/host/services/watches.ts),
[`watches.ts`](src/contracts/watches.ts)).

```ts
type ThreadWatchItem =
  | {
      kind: 'snapshot';
      threadId: string;
      projectId: string | null;
      project: Project | null;
      thread: Thread | null;
      events: ThreadEvent[];
    } // events after afterSequence; an unknown Thread answers nulls and []
  | { kind: 'event'; event: ThreadEvent } // after the snapshot, in sequence order
  | { kind: 'updated'; thread: Thread }
  | { kind: 'deleted'; projectId: string; threadId: string };

type ProjectWatchItem =
  | {
      kind: 'snapshot';
      projectId: string;
      project: Project | null;
      threads: Thread[];
    }
  | { kind: 'project-updated'; project: Project }
  | { kind: 'project-deleted'; projectId: string }
  | { kind: 'thread-updated'; thread: Thread }
  | { kind: 'thread-deleted'; projectId: string; threadId: string };
```

The Thread snapshot reads the stored record, without the storage-pause overlay
of [Storage pressure](#storage-pressure);
after the snapshot the stream sends the buffered events first, then the
lifecycle notices. The Project snapshot carries every Thread of the Project
(`projectThreads`) and no terminals.

### `runtime.workspace/v1`

The working directory of the calling prompt's own Thread, and tasks on a live
Thread ([`workspace.ts`](src/contracts/workspace.ts),
[`services/workspace.ts`](src/host/services/workspace.ts)). Bundles only.

| Method               | Input                                          | Output                                      |
| -------------------- | ---------------------------------------------- | ------------------------------------------- |
| `cwd`                | none                                           | `string` (absolute inside the sandbox)      |
| `setCwd`             | `path`                                         | `CwdChange`                                 |
| `location`           | none                                           | `{ cwd: string; repo?: 'git' \| 'github' }` |
| `withThread` (local) | `[threadId, WithThreadOptions, ThreadTask<T>]` | `ThreadTaskOutcome<T>`                      |

```ts
type CwdChange =
  | { status: 'set'; cwd: string }
  | { status: 'outside' | 'missing' | 'not-directory' };
interface WithThreadOptions {
  exclusive: boolean;
  resume?: boolean;
  refreshHint?: boolean;
}
interface ThreadContext {
  projectId: string;
  threadId: string;
  cwd: string;
  sandbox: Sandbox;
  closing(): boolean; // the Project or the Thread started closing
  busyCwds(): readonly string[]; // cwds of the Project's Threads with an active or queued prompt
}
type ThreadTask<T> = (thread: ThreadContext) => Promise<T>;
type ThreadTaskOutcome<T> =
  | { status: 'ready'; value: T }
  | { status: 'missing' | 'inactive' | 'pending' };
```

`cwd`, `setCwd` and `location` are bound to the calling prompt like the
prompt-scoped controls. `cwd` needs only a live binding and answers the stored
`cwd`. `setCwd` and `location` also reject with
`Error('Thread control is no longer active.')` when the Project or the Thread
is closing, or the prompt has finished or been aborted. `setCwd` follows the
[working directory rules](#working-directory-and-repository-hint); when the
move answers `inactive` or `missing`, it rejects with the same error.
`location` probes the repository hint now; when the
probed hint differs from the stored one, it writes it, publishes a Thread update
and fires `onThreadCwdChangedHook`; a probe that fails or times out answers the
hint already stored. `withThread` runs `task` on one live Thread whatever the
call's scope: `exclusive` runs it under the Project lock, `resume` brings the
Project back from durable state first, `refreshHint` re-reads the hint after the
task. It answers `missing` (no record), `inactive` (no runtime, closing or
terminal) or `pending` (no lease); the task's own rejection propagates
([`service.ts`](src/host/domain/service.ts),
[`runner.ts`](src/host/domain/runner.ts)).

### `runtime.lease/v1`

Operations on the sandbox leased to the calling Project
([`lease.ts`](src/contracts/lease.ts),
[`services/lease.ts`](src/host/services/lease.ts)). Bundles only.

| Method              | Input                                                              | Output                                                         |
| ------------------- | ------------------------------------------------------------------ | -------------------------------------------------------------- |
| `describe`          | none                                                               | `{ id: string; root: string }`                                 |
| `exec`              | `{ cmd: string[]; cwd?; env?: string[]; user?; timeoutMs?; tty? }` | `{ exitCode: number \| null; stdout: string; stderr: string }` |
| `readFile`          | `path`                                                             | `string`                                                       |
| `readFileBytes`     | `path`                                                             | `string` (the file's exact bytes, base64)                      |
| `writeFile`         | `[path, content]`                                                  | `void`                                                         |
| `ssh`               | none                                                               | `ProjectSsh`                                                   |
| `withLease` (local) | `LeaseTask<T>` (`(sandbox: Sandbox) => Promise<T>`)                | `LeaseOutcome<T>`                                              |

```ts
type LeaseOutcome<T> =
  | { status: 'ready'; value: T }
  | { status: 'pending' | 'unavailable' | 'expired' | 'missing' };
```

- `describe`, `exec`, `readFile`, `readFileBytes` and `writeFile` resolve the
  sandbox from the scope: with a `promptId`, the prompt's bound sandbox; else
  the Project of `projectId`, or of `threadId`'s Thread; with neither, or with
  a `threadId` that names no Thread, the Project with the latest activity. A Project whose lease is not ready rejects
  with `ContractError('unavailable', 'Project lease is not ready (<status>).')`;
  no Project rejects with `ContractError('invalid_input', 'runtime.lease/v1 needs a Project or Thread scope.')`.
  With a `promptId` whose binding has ended, or that belongs to another Thread
  or Project, they reject with `Error('Thread control is no longer active.')`
  ([`bindings.ts`](src/host/domain/bindings.ts)).
  `exec`, `readFile`, `readFileBytes` and `writeFile` pass their input to the
  `Sandbox` methods `exec`, `readFile`, `getFile` and `writeFile` unchanged,
  and the sandbox's rejections propagate; the meaning of `cwd`, `env`, `user`,
  `timeoutMs` and `tty` is the `sandbox` package's
  ([`SandboxSession`](../../../packages/sandbox/README.md#sandboxsession) for
  what each method does, and
  [Implementing a provider](../../../packages/sandbox/README.md#implementing-a-provider)
  for the `SandboxExecInput` shape).
  `exec` passes no abort signal and returns text only.
- `ssh` and `withLease` need `call.scope.projectId` (else the same
  `invalid_input`) and never acquire a lease. They answer `missing` (no
  Project), `expired` (a terminal Project without a runtime), `unavailable` (no
  runtime, closing, or closing or lease loss during the task) and `pending` (no
  lease yet). `ssh` also answers `unavailable` when the sandbox gives no SSH
  access. A `withLease` task's own rejection propagates
  ([`service.ts`](src/host/domain/service.ts)).

### `runtime.attachments/v1`

Images a Thread attached ([`attachments.ts`](src/contracts/attachments.ts),
[`services/attachments.ts`](src/host/services/attachments.ts),
[`store/attachments.ts`](src/host/store/attachments.ts)).

| Method             | Input                                          | Output                           |
| ------------------ | ---------------------------------------------- | -------------------------------- |
| `attach` _desktop_ | `{ name: string; bytes: string /* base64 */ }` | `Attachment`                     |
| `read` _desktop_   | `{ id }`                                       | `AttachmentContent \| undefined` |

```ts
interface Attachment {
  id: string /* sha256-<64 hex> */;
  name: string /* 1–200 */;
  mediaType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif';
  size: number; /* > 0 */
}
interface AttachmentContent extends Attachment {
  bytes: string; /* base64 */
}
```

- `attach` needs `call.scope.threadId` (else `ContractError('invalid_input', 'runtime.attachments/v1.attach needs a Thread scope.')`);
  a Thread that does not exist rejects with `ContractError('not_found', 'Thread <id> does not exist.')`.
  It refuses with `ContractError('invalid_input', message)` bytes that are
  empty (`The attachment is empty.`), larger than 5 MiB
  (`The attachment is larger than 5 MiB.`), or not a PNG, JPEG, WebP or GIF by
  their first bytes (`The attachment is not a PNG, JPEG, WebP or GIF image.`;
  `sniffImageMediaType`, the name does not decide). The input accepts any
  `name` string; the stored name is `attachmentLabel(name)` (see
  [Other exports](#other-exports-of-runtimecontracts)). The bytes are kept once
  as a content-addressed blob; attaching the same bytes again answers the same
  id ([`store/attachments.ts`](src/host/store/attachments.ts)).
- `read` answers for the Project of `call.scope.threadId`, else
  `call.scope.projectId` (else `ContractError('invalid_input', 'runtime.attachments/v1 needs a Project or Thread scope.')`).
  A `threadId` that names no Thread rejects with
  `ContractError('not_found', 'Thread <id> does not exist.')` and does not fall
  back to `projectId` ([`services/attachments.ts`](src/host/services/attachments.ts)).
  Every Thread of a Project reads its images. A malformed id, an id the Project
  holds no record of, or a missing blob answers `undefined`
  ([`store/attachments.ts`](src/host/store/attachments.ts)).

In text, an attachment is the Markdown line
`![<name>](doric-attachment:sha256-<64 hex>)`; prompts, queued inputs and tool
results stay text everywhere they travel, and the executor reads the bytes only
for an attachment the Project holds.

### `runtime.hooks/v1`

Hooks the runtime fires ([`hooks.ts`](src/contracts/hooks.ts),
[`ports.ts`](src/host/ports.ts)). All are `observe` hooks; a failing handler
never fails the runtime's work. See
[hooks](../../../docs/architecture/bundles/hooks.md) for how hooks work.

| Hook                     | Input                                                                            | When, and whether awaited                                                                                                                                                                                  |
| ------------------------ | -------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `onProjectReadyHook`     | `{ projectId }`                                                                  | After the Project's `ready` commit; not awaited.                                                                                                                                                           |
| `onProjectClosingHook`   | `{ projectId }`                                                                  | After the Project's `cancelling` commit; not awaited.                                                                                                                                                      |
| `onThreadsClosingHook`   | `{ projectId, threadIds: string[] }`                                             | When Threads close (termination, failure, host stop, drain); awaited, while the runner waits up to 1 s for aborted runs to end. Handlers close their terminals; the runtime has none.                      |
| `onPromptStartedHook`    | `{ projectId, threadId, promptId, source: InputSource, cwd, cwdRepo? }`          | After `prompt.started` and before the executor runs, outside the Project lock; awaited, so an instruction a handler gives is read before the first model request.                                          |
| `onThreadCwdChangedHook` | `{ projectId, threadId, promptId?, cwd, cwdRepo?, previous: { cwd, cwdRepo? } }` | After a Thread's `cwd` or `cwdRepo` changed, outside the Project lock, before the move answers its caller; awaited. A reset of a directory a reacquired sandbox no longer holds fires it without awaiting. |

`onThreadsClosingHook` is not fired for an empty list of Threads
([`runner.ts`](src/host/domain/runner.ts)). `PromptStarted` and `CwdChanged` are the input types of the last two hooks.

### `runtime.usage/v1`

| Method | Input      | Output                     |
| ------ | ---------- | -------------------------- |
| `read` | `threadId` | `ThreadUsage \| undefined` |

The Thread's stored usage projection, without the context capacity fill (see
[Usage](#usage)) that `runtime.threads/v1.usage` adds ([`usage.ts`](src/contracts/usage.ts),
[`services/usage.ts`](src/host/services/usage.ts)).

### `runtime.records/v1`

The window's mirror of the host's Projects and Threads, provided by the client
part in each window; it ignores `call` ([`records.ts`](src/contracts/records.ts),
[`src/client/records.ts`](src/client/records.ts)). Its behavior is in
[Client part](#client-part-the-records-mirror).

```ts
type RecordsRead<T> =
  | { status: 'loading'; value?: T }
  | { status: 'ready'; value: T }
  | {
      status: 'failed';
      value?: T;
      error: { code: string; message: string /* other fields kept */ };
    };

interface RuntimeRecords {
  // Reads: local and synchronous.
  projects(): RecordsRead<readonly Project[]>;
  project(projectId: string): Project | undefined;
  threads(projectId: string): RecordsRead<readonly Thread[]>;
  thread(threadId: string): Thread | undefined;
  connection(): 'connected' | 'disconnected';
  subscribe(listener: () => void): Disposable;
  // Loads.
  follow(input: { projectId: string }): Disposable;
  reload(
    input: { target: 'projects' } | { target: 'threads'; projectId: string },
  ): void;
  findThread(input: { threadId: string }): Promise<Thread | undefined>;
  activity(): Promise<readonly ProjectActivity[]>;
  // Writes.
  createProject(input: { name: string }): Promise<Project>;
  renameProject(input: { projectId: string; name: string }): Promise<Project>;
  setProjectColor(input: {
    projectId: string;
    color?: ProjectColor;
  }): Promise<Project>;
  terminateProject(input: { projectId: string }): Promise<Project>;
  deleteProject(input: { projectId: string }): Promise<void>;
  createThread(input: {
    projectId: string;
    name: string;
    parentThreadId?: string;
  }): Promise<Thread>;
  renameThread(input: { threadId: string; name: string }): Promise<Thread>;
  terminateThread(input: { threadId: string }): Promise<Thread>;
  deleteThread(input: { threadId: string }): Promise<void>;
  archiveThread(input: {
    threadId: string;
  }): Promise<{ batch: string; threads: readonly Thread[] }>;
  restoreThread(input: {
    threadId: string;
    batch?: string;
  }): Promise<readonly Thread[]>;
  setThreadPinned(input: {
    threadId: string;
    pinned: boolean;
  }): Promise<Thread>;
  // Presence.
  view(input: { threadId: string }): Disposable;
}
```

`runtimeRecordsService(records)` wraps a `RuntimeRecords` in the service
definition, reading each member at call time; `threadSubtreeIds(threads, rootId)`
answers the ids of `rootId` and of every Thread below it through
`parentThreadId`, always including `rootId` ([`records.ts`](src/contracts/records.ts)).

### `runtime.prompt-finished/v1`

The qualified event type of the durable `prompt.finished` event, registered on
`events/v1` at activation ([`events.ts`](src/contracts/events.ts)). Its payload
schema (loose) is `{ status: 'completed' | 'failed' | 'cancelled'; text: string; source: InputSource; reason?: 'queue_removed' }`.
The rows the runtime writes are `{ status, text, source, reason? }` with
`reason` either `'queue_removed'` (`removeQueued`) or `'interrupted'` (a
prompt the reader stopped, written by `finishJob` in
[`runner.ts`](src/host/domain/runner.ts)). The schema does not accept
`'interrupted'`, so a consumer that validates a row with `promptFinishedEvent`
rejects every interrupted prompt's row. Stored rows carry
`type: 'prompt.finished'`; `legacyEventTypes` and `qualifiedType` map that
durable type to the qualified one.

The storage types `runtime.project/v1`, `runtime.thread/v1`,
`runtime.history/v1`, `runtime.attachment/v1` and `runtime.migration/v1` are in
[Data and storage](#data-and-storage).

## Contracts it declares for other providers

`runtime/contracts` declares two contracts the runtime requires and other
bundles provide.

### `executor/v1`

One prompt run; cardinality `one`; provided by the
[`default`](../default/README.md) bundle ([`executor.ts`](src/contracts/executor.ts)).

```ts
interface PromptJob {
  id: string;
  prompt: string;
  source: InputSource;
}
type SteerInput = Pick<PromptJob, 'prompt' | 'source'>;
type ExecutorThread = Thread & {
  agent?: {
    name: string;
    source: 'built-in' | 'workspace';
    instructions: string;
  };
};

interface HistoryReader {
  readonly format: string | undefined;
  read(part: string): Promise<unknown>;
}
interface HistoryPatch {
  format: string;
  parts: Record<string, unknown>;
}

interface PromptSession {
  readonly history: HistoryReader;
  record(entry: { history?: HistoryPatch; event?: unknown }): Promise<void>;
  steers?(): Promise<readonly SteerInput[]>;
  attachment?(id: string): Promise<AttachmentContent | undefined>;
}

interface Executor {
  run(input: {
    thread: ExecutorThread;
    job: PromptJob;
    session: PromptSession;
  }): Promise<{ text: string }>;
  checkpoint(input: {
    history: HistoryReader;
    promptId: string;
  }): Promise<HistoryPatch>;
  rewind(input: {
    history: HistoryReader;
    promptId: string;
    removedPromptIds: readonly string[];
  }): Promise<HistoryPatch | undefined>;
  formats(): readonly string[];
  compact(input: {
    thread: ExecutorThread;
    session: PromptSession;
    policy: { tailMinMessages: number; summaryMaxChars: number };
  }): Promise<ExecutorCompactionResult>;
}
type ExecutorCompactionResult =
  | {
      status: 'compacted';
      summaryId: string;
      condensedMessages: number;
      retainedMessages: number;
      tokensFreed: number;
    }
  | {
      status: 'refused';
      reason: 'disabled' | 'missing_history' | 'nothing_to_compact';
    }
  | { status: 'failed'; code: 'summarizer_failed' | 'unsafe_boundary' };
```

- `run` gets `call.scope = { projectId, threadId, promptId }` and an abort
  `call.signal`. Every history and event write of the run goes through the
  session: `record` saves `history` first, then appends `event` to the Thread's
  log and publishes it, redacting both; on a failure it throws the runtime's
  persistence error and keeps the retry ([`session.ts`](src/host/domain/session.ts)).
- `steers` hands the executor, oldest first, the inputs that arrived for the
  running prompt (the reader's steering, child results, terminal results); the
  executor records one `{ type: 'agent.steered' }` event per input it takes in,
  which the session logs as `prompt.steered` under the steer's own id. An input
  it never takes in returns to the front of the queue when the run ends.
- `checkpoint` records the turn boundary before `prompt.started`; an existing
  boundary wins. `rewind` returns the truncated state, or `undefined` when the
  prompt has no boundary.
- `executorThreadSchema` requires a string `instructions` whenever `agent` is
  present. The runtime passes the instructions stored on the Thread document;
  when an agent Thread has none stored, it passes no `agent`, and the executor
  runs the default agent ([`runner.ts`](src/host/domain/runner.ts)).
- `run` and `compact` resolve the Thread's provider, model and effort with
  `resolveThreadExecution`; the runtime requires `^1.4.0` for that.

### `sandbox/v1`

The Project sandboxes; cardinality `one`; provided by the
[`docker`](../../sandboxes/docker/README.md) or
[`firecracker`](../../sandboxes/firecracker/README.md) bundle
([`sandbox.ts`](src/contracts/sandbox.ts)).

```ts
interface SandboxProviderApi {
  describe(): Promise<{ provider: string; durableWorkspace: boolean }>;
  acquire(input: {
    identity: string;
    signal?: AbortSignal;
  }): Promise<SandboxLease>; // local
  discard(identity: string): Promise<void>;
  machines(): Promise<readonly { id: string; provider: string }[]>;
  machine(id: string): Promise<{ id: string; provider: string } | undefined>;
}
```

The runtime acquires with the Project id as `identity`, and discards that
identity when the Project is deleted
([`service.ts`](src/host/domain/service.ts)). A resumed Project gets its own
workspace back only from a provider whose `describe()` answers
`durableWorkspace: true`: Docker keeps the workspace of each identity
([`docker/src/host/sandbox.ts`](../../sandboxes/docker/src/host/sandbox.ts)),
while Firecracker answers `false` and provisions a fresh microVM from its image
for every acquisition
([`firecracker/src/host/sandbox.ts`](../../sandboxes/firecracker/src/host/sandbox.ts)).

## Other exports of `runtime/contracts`

- **Names** ([`model.ts`](src/contracts/model.ts)): `maximumNameLength` (80),
  `normalizeName` (trim), `isValidName` (no NUL, 1–80 code points),
  `nameFromPrompt` (trimmed, NUL replaced by U+FFFD, first 80 code points);
  `projectColors`, `isProjectColor`; `isTerminal(state)`; `storageMessage`;
  `reasoningEfforts`.
- **Scope** ([`scope.ts`](src/contracts/scope.ts)): `RuntimeScope`
  (`{ projectId?, threadId?, promptId? }`), `runtimeScope(scope)` builds the
  `CallScope` with only the keys present, `readRuntimeScope(call)` reads them.
- **Execution rules** ([`execution.ts`](src/contracts/execution.ts)), pure and
  shared with the `default` executor and the settings client:
  `ExecutionConfiguration`, `ThreadExecution`, `threadExecutionIssues`
  (`['provider', 'model', 'effort']`), `resolveThreadExecution`, `modelEfforts`,
  `modelDefaultEffort`, `modelStartEffort` (see
  [Execution](#execution-provider-model-and-effort)).
- **Fences** ([`fences.ts`](src/contracts/fences.ts)): `fenceMarker`,
  `closesFence`, `fenceInfo`, `isQuestionLine` (`/^root\s*=\s*AskForm\(/`),
  `completedStatements`, `firstCompletedLine`, `questionFenceTag`
  (`openui-lang`) and `hasQuestionForm(text)`, true when a fence tagged
  `openui-lang` has a first completed line that is a question line. The archiver
  and the window's chat use the same rules.
- **Deltas** ([`deltas.ts`](src/contracts/deltas.ts)): `StreamDelta`
  (`{ type: 'text.delta' | 'reasoning.delta' | 'refusal.delta'; delta }` or
  `{ type: 'tool_call.delta'; index; id?; name?; argumentsDelta? }`),
  `streamDelta(value)`, `isEmptyDelta`, and `mergeDeltas(left, right)`, which
  merges two deltas only when nothing a reader draws can tell them apart: same
  kind, same tool call (index, and `id` and `name` agreeing), and never answer
  text whose blank start would join the words that follow.
- **Attachments** ([`attachments.ts`](src/contracts/attachments.ts)):
  - `attachmentMediaTypes`: `image/png`, `image/jpeg`, `image/webp`,
    `image/gif`; `ATTACHMENT_MAX_BYTES` is 5 MiB; `ATTACHMENT_MAX_NAME` is 200.
  - `attachmentLabel(name)` replaces line breaks with a space, removes `[` and
    `]`, trims, keeps the first 200 characters, and answers `image` when
    nothing is left.
  - `attachmentReference(name, id)` answers the line
    `![<attachmentLabel(name)>](doric-attachment:<id>)`.
  - `attachmentReferences(text)` finds every reference matching
    `/!\[([^\]\n]*)\]\(doric-attachment:(sha256-[0-9a-f]{64})\)/gu`, in order,
    as `{ name, id, start, end }`; `attachmentLine(line)` answers the one
    reference a trimmed line consists of, else `undefined`.
  - `withAttachmentPlaceholders(text)` replaces each reference with `[name]`.
  - `attachmentBlobHash(id)` maps `sha256-<hex>` to the blob hash
    `sha256:<hex>`; `attachmentIdOf(hash)` maps it back.
  - `sniffImageMediaType(bytes)` decides the type from the first bytes only:
    `89 50 4E 47 0D 0A 1A 0A` PNG, `FF D8 FF` JPEG, `47 49 46 38` GIF, `RIFF`
    with `WEBP` at offset 8 WebP; anything else is `undefined`.
- **REST errors** ([`rest-errors.ts`](src/contracts/rest-errors.ts)):
  `RestError` (`{ status, code, message }`); `notFoundError(kind)` (404
  `<kind>_not_found`, "The <kind> was not found."); `conflictError(kind,
reason)` (409 `<kind>_<reason>`, "The <kind> cannot perform this
  operation.", or `storageMessage` when `reason` is `storage_low`);
  `promptNotFoundError` (404 `prompt_not_found`, "The prompt was not found in
  this Thread."); `cwdRefusalMessages`; `threadExecutionMessages`;
  `SwitchBranchOutcome` (`{ status: 'ready' } | { status: 'missing' | 'inactive' | 'pending' } | { status: 'refused'; message: string }`);
  `restErrors`, below; and `restContractError(error)`,
  which builds the `ContractError` a UI adapter throws, with `status` in its
  details. Each `restErrors` entry answers `undefined` for the route's
  success:

  | Key                                 | Route                                                                                                                | Outcome → status `code` (message)                                                                                                                                                                                                                                                                                                                             |
  | ----------------------------------- | -------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
  | `project`                           | `GET /projects/:id`, `PATCH /projects/:id[/color]`, `POST …/terminate`                                               | absent → 404 `project_not_found`                                                                                                                                                                                                                                                                                                                              |
  | `deleteProject`                     | `DELETE /projects/:id`                                                                                               | `missing` → 404 `project_not_found`; `active` → 409 `project_active`; any other outcome, `forbidden` included, → success                                                                                                                                                                                                                                      |
  | `createThread`                      | `POST /projects/:id/threads`                                                                                         | `missing` → 404 `project_not_found`; any other refusal → 409 `thread_<status>`                                                                                                                                                                                                                                                                                |
  | `threads`                           | `GET /projects/:id/threads`                                                                                          | absent → 404 `project_not_found`                                                                                                                                                                                                                                                                                                                              |
  | `thread`                            | `GET /threads/:id`, rename of `PATCH /threads/:id`, `POST …/terminate`, `GET …/queue`, `GET …/usage`, `GET …/events` | absent → 404 `thread_not_found`                                                                                                                                                                                                                                                                                                                               |
  | `setThreadCwd`                      | cwd of `PATCH /threads/:id`                                                                                          | `missing` → 404; `inactive` → 409 `thread_inactive`; `refused` → 400 `invalid_cwd` ("The working directory must stay inside the workspace.", "No such directory." or "The working directory must be a directory.")                                                                                                                                            |
  | `setThreadExecution`                | execution of `PATCH /threads/:id`                                                                                    | `missing` → 404; `invalid` → 422 `invalid_execution` ("The provider is not configured.", "The model is not available on this provider." or "This model does not support that effort."); `unresolvable` → 422 `invalid_execution` (the result's `message`)                                                                                                     |
  | `deleteThread`                      | `DELETE /threads/:id`                                                                                                | as `deleteProject`, with `thread_*` codes                                                                                                                                                                                                                                                                                                                     |
  | `prompt`                            | `POST /threads/:id/prompt`                                                                                           | `missing` → 404; any other refusal → 409 `thread_inactive`                                                                                                                                                                                                                                                                                                    |
  | `steer`                             | `POST /threads/:id/steer`                                                                                            | `steered` and `queued` succeed; `missing` → 404; otherwise 409 `thread_inactive`                                                                                                                                                                                                                                                                              |
  | `resume`                            | `POST /threads/:id/resume`                                                                                           | `missing` → 404; `unknown_prompt` → `promptNotFoundError`; otherwise 409 `thread_<status>`                                                                                                                                                                                                                                                                    |
  | `rewind`                            | `POST /threads/:id/rewind`                                                                                           | `missing` → 404; `unknown_prompt` → `promptNotFoundError`; `busy` → 409 `thread_busy` ("The Thread is running or has queued input and cannot be rewound."); otherwise 409 `thread_inactive`                                                                                                                                                                   |
  | `pause`                             | `POST /threads/:id/interrupt`                                                                                        | `missing` → 404; otherwise 409 `thread_<result>`                                                                                                                                                                                                                                                                                                              |
  | `resumeQueue`                       | `POST /threads/:id/queue/resume`                                                                                     | `missing` → 404; otherwise 409 `thread_<status>` (`storageMessage` for `storage_low`)                                                                                                                                                                                                                                                                         |
  | `removeQueued`                      | `DELETE /threads/:id/queue/:promptId`                                                                                | `missing` → 404; otherwise 409 `thread_<result>`                                                                                                                                                                                                                                                                                                              |
  | `queuedPrompt`                      | `GET /threads/:id/queue/:promptId`                                                                                   | absent → 404 `unknown_prompt` ("This prompt is no longer queued.")                                                                                                                                                                                                                                                                                            |
  | `editQueued`                        | `PATCH /threads/:id/queue/:promptId`                                                                                 | `missing`, `unknown_prompt` → 404, others → 409, code = status; `conflict`: "This prompt was edited elsewhere. Your changes have not been saved."; `not_editable`: "Only your prompts that have not started can be edited. Your changes have not been saved."; any other: "This prompt is no longer available for editing. Your changes have not been saved." |
  | `switchBranch`                      | `POST /threads/:id/branches` (`git.commands/v1`)                                                                     | `missing` → 404; `refused` → 409 `branch_refused` (the outcome's `message`); otherwise 409 `thread_inactive`                                                                                                                                                                                                                                                  |
  | `createTerminal`                    | `POST /threads/:id/terminals` (`terminal/v1`)                                                                        | absent → 409 `terminal_unavailable` ("The Thread has no active sandbox.")                                                                                                                                                                                                                                                                                     |
  | `terminalSnapshot`, `terminalWrite` | `GET /terminals/:id`, `POST /terminals/:id/input` and `…/resize`                                                     | absent or not written → 404 `terminal_missing` ("Terminal no longer exists.")                                                                                                                                                                                                                                                                                 |

- **Tool host** ([`tool-host/`](src/contracts/tool-host/index.ts)): `Host`
  (`{ threads: ThreadControl; workspace: WorkspaceControl }`), the per-prompt
  facade the runner builds; `ThreadControl` mirrors the prompt-scoped controls
  without `call`, and `WorkspaceControl` is `cwd(): string`,
  `setCwd(path)` and `location()`.
- **Storage** ([`storage.ts`](src/contracts/storage.ts)): the document schemas,
  storage types, ids and stream names of [Data and storage](#data-and-storage),
  and `threadEventSink`.
- **Configuration types** ([`configuration.ts`](src/contracts/configuration.ts)):
  the `host-config` value types, re-exported as types only.

## Contracts it uses

| Contract              | What the runtime uses it for                                                                                                                                                                                                                         |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `storage/v1`          | Its documents, the Thread event streams and the attachment blobs; `health()` for the storage-pressure rule ([`src/host/store/`](src/host/store/), [`storage-pressure.ts`](src/host/domain/storage-pressure.ts)).                                     |
| `events/v1`           | Registers `runtime.prompt-finished/v1` and the event sink that routes every event scoped to a Thread into that Thread's stream ([`index.ts`](src/host/index.ts)).                                                                                    |
| `hooks/v1`            | Defines `runtime.hooks/v1`, and uses `doric.app.hooks/v1` (start, stop, generation change, peer signal) and `core.event-hooks/v1` ([`ports.ts`](src/host/ports.ts), [`lifecycle.ts`](src/host/lifecycle.ts), [`handover.ts`](src/host/handover.ts)). |
| `core.event-hooks/v1` | `onEventAppendedHook({ stream, type })`: folds an event another bundle appended into its Thread ([`appends.ts`](src/host/appends.ts), [`peers.ts`](src/host/peers.ts)).                                                                              |
| `log/v1`              | Every log line of the host part ([`ports.ts`](src/host/ports.ts)).                                                                                                                                                                                   |
| `secrets/v1`          | `resolve`, `resolveByKind` and `redactions`: the Git identity and GitHub token, and the redaction list ([`ports.ts`](src/host/ports.ts)).                                                                                                            |
| `models/v1`           | `resolve` validates an execution and reads the catalog's context window; `kind` names the secret fields of each provider kind ([`ports.ts`](src/host/ports.ts)).                                                                                     |
| `host-config/v1`      | `current()`: the configuration in force ([`ports.ts`](src/host/ports.ts)).                                                                                                                                                                           |
| `executor/v1`         | Runs, checkpoints, rewinds and compacts each prompt, bound to the prompt's scope ([`runner.ts`](src/host/domain/runner.ts)).                                                                                                                         |
| `sandbox/v1`          | `acquire` and `discard` of each Project's sandbox ([`service.ts`](src/host/domain/service.ts)).                                                                                                                                                      |

Platform contracts, which need no declaration: `doric.generation/v1`
(`describe`, `hold`, `signal`), `doric.startup/v1` (`stage`, `log`) and, in the
client part, `doric.connection/v1`.

## Data and storage

The host part defines five storage types on activation
([`storage.ts`](src/contracts/storage.ts),
[`store/index.ts`](src/host/store/index.ts)). Every document schema is strict:
every write is validated, and a document with a field the schema does not name
fails validation. `createdKey` is `createdAt + '|' + id`, the single sortable
field of the list indexes.

### `runtime.project/v1`

Document id: the Project id. Indexes: `byCreated` (`createdKey`), `byOpen`
(`open`, `createdKey`).

| Field                     | Type                                                           | Meaning                                                                   |
| ------------------------- | -------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `id`                      | uuid                                                           |                                                                           |
| `name`                    | string                                                         |                                                                           |
| `color`                   | string \| null                                                 | Any stored text; the public record shows only palette values.             |
| `state`                   | `queued` \| `ready` \| `cancelling` \| `cancelled` \| `failed` |                                                                           |
| `open`                    | boolean                                                        | Not `failed` or `cancelled`.                                              |
| `configRevision`          | int                                                            |                                                                           |
| `configSnapshot`          | unknown                                                        | The full configuration at creation, never read for execution.             |
| `errorCode`               | string \| null                                                 |                                                                           |
| `createdAt`, `updatedAt`  | ISO 8601                                                       |                                                                           |
| `startedAt`, `finishedAt` | ISO 8601 \| null                                               |                                                                           |
| `createdKey`              | string                                                         |                                                                           |
| `owner`                   | `{ generation, incarnation }` \| null, optional                | The runtime process holding the Project live; never in the public record. |

### `runtime.thread/v1`

Document id: the Thread id. Indexes: `byProject` (`projectId`, `createdKey`),
`byParent` (`projectId`, `parentThreadId`, `createdKey`), `byOpen` (`open`,
`createdKey`).

| Field                     | Type                                                                   | Meaning                                                        |
| ------------------------- | ---------------------------------------------------------------------- | -------------------------------------------------------------- |
| `id`, `projectId`         | uuid                                                                   |                                                                |
| `parentThreadId`          | uuid \| null                                                           |                                                                |
| `origin`                  | `user` \| `agent`, optional                                            | Absent: the reader's.                                          |
| `name`                    | string                                                                 |                                                                |
| `state`                   | the six Thread states                                                  |                                                                |
| `open`                    | boolean                                                                | Not `failed` or `cancelled`.                                   |
| `cwd`                     | string                                                                 | `/workspace` for a top-level Thread; the parent's for a child. |
| `cwdRepo`                 | `git` \| `github` \| null                                              |                                                                |
| `queuePaused`             | boolean                                                                |                                                                |
| `activePromptId`          | uuid \| null                                                           |                                                                |
| `errorCode`               | string \| null                                                         |                                                                |
| `lastSequence`            | int                                                                    | Equals the event stream's counter.                             |
| `result`                  | `{ status, text, promptId: uuid, at, reason?: 'interrupted' }` \| null | `reason` is present when the reader stopped the turn.          |
| `lastStarted`             | `{ promptId: uuid, at }` \| null                                       | The latest `prompt.started`.                                   |
| `usage`                   | `UsageState` \| null (schema: unknown)                                 | The usage state below; null derives it once from the events.   |
| `pending`                 | `PendingPrompt[]` \| null                                              | The unfinished prompts; null folds them from the stream.       |
| `createdAt`, `updatedAt`  | ISO 8601                                                               |                                                                |
| `startedAt`, `finishedAt` | ISO 8601 \| null                                                       |                                                                |
| `agent`                   | `{ name, source, instructions (≤ 64 000) }`, optional                  | The instructions reach only the executor.                      |
| `model`                   | string, optional                                                       |                                                                |
| `effort`                  | `ReasoningEffort`, optional                                            |                                                                |
| `providerId`              | string, optional                                                       |                                                                |
| `archive`                 | `{ at, batch: uuid }`, optional                                        | Present while archived.                                        |
| `restoredAt`              | ISO 8601, optional                                                     | The last undo of an archive.                                   |
| `pinned`                  | `true`, optional                                                       | Present while pinned.                                          |
| `viewedAt`                | ISO 8601, optional                                                     | The last start or end of a view.                               |
| `createdKey`              | string                                                                 |                                                                |

```ts
interface PendingPrompt {
  // strict
  promptId: string;
  text: string;
  revision?: number;
  source: InputSource;
  started: boolean;
  paused?: 'host_stopped' | 'host_restarted' | 'reader_stopped' | 'storage_low';
  superseded?: boolean;
  attempts: number; // how many times the host resumed it
  acceptedAt?: string;
  acceptedSequence: number; // boot order across Threads: (acceptedSequence, threadId)
  queuedSequence?: number;
  pausedSequence?: number;
  first?: boolean; // goes to the front of the queue
  steer?: string; // the prompt this steering input waits to be taken into
}
```

### `runtime.history/v1`

The executor's opaque, versioned state of a Thread: one document per named part,
id `<threadId>:<part>`; index `byThread` (`threadId`). Fields:
`{ threadId, projectId, format, part, value }`. The store keeps each value made
storable and never reads it ([`store/history.ts`](src/host/store/history.ts)).

### `runtime.attachment/v1`

One image a Thread attached; id `<threadId>:<attachment id>`. Fields:
`{ projectId, threadId, id, name, mediaType, size, createdAt }`. Indexes:
`byProject` (`projectId`, `id`), `byThread` (`threadId`), `byBlob` (`id`). The
bytes are one `storage/v1` blob, shared by every record that names the same
hash; deleting a Thread or a Project deletes its records in the same commit, and
then deletes each blob no record names any more. Attaches and collects of one
blob run one at a time ([`store/attachments.ts`](src/host/store/attachments.ts)).

### `runtime.migration/v1`

One marker document, id `legacy-prisma`:
`{ source: 'prisma-legacy', completedAt, counts: { projects, threads, events, histories } }`.
The runtime defines the type, and no code under `src/` reads or writes a
document of it; only tests outside this bundle
(`app/backend/doric-host/tests/stage7-migration.test.ts`,
`bundles/foundation/postgres/tests/drop-legacy-tables.test.ts`) and
`tests/runtime-contracts.test.ts` use the schema. The code states no other
reason for defining it.

### Event streams

Each Thread has one stream, `runtime.thread.events/<threadId>`
(`threadEventsStream`, `threadIdOfStream`). Each entry's value is
`{ projectId, threadId, promptId, type, event }` (strict; `event` is an object);
its sequence and `createdAt` are the stream entry's. `threadEventSink` makes
`events/v1` write every event scoped to `{ projectId, threadId, promptId }` into
that stream, with the keys in that order ([`events.ts`](src/contracts/events.ts)).

An event append commits the entries together with the Thread document's
`lastSequence`, `queuePaused`, usage fold, `lastStarted` and `pending`
projection ([`store/threads.ts`](src/host/store/threads.ts)). When another
bundle appended through `events/v1`, the document lags the stream: the runtime
folds those entries in when `onEventAppendedHook` fires, or on a
`sequence_conflict` retry of its own commit, and publishes them once.

Events the runtime itself writes ([`runner.ts`](src/host/domain/runner.ts),
[`session.ts`](src/host/domain/session.ts),
[`storage-pause.ts`](src/host/domain/storage-pause.ts),
[`store/threads.ts`](src/host/store/threads.ts)):

| Type                              | Body                                                                                  |
| --------------------------------- | ------------------------------------------------------------------------------------- |
| `prompt.accepted`                 | `{ text, source, queued, steer? }`                                                    |
| `prompt.queued`                   | `{ first? }`                                                                          |
| `prompt.edited`                   | `{ text }`                                                                            |
| `prompt.started`                  | `{}`                                                                                  |
| `prompt.steered`                  | `{ promptId, text, source }`, under the steer's own id                                |
| `prompt.paused`                   | `{ reason: 'host_stopped' \| 'host_restarted' \| 'storage_low' \| 'reader_stopped' }` |
| `prompt.resumed`                  | `{ attempt, first? }`                                                                 |
| `prompt.finished`                 | `{ status, text, source, reason?: 'interrupted' \| 'queue_removed' }`                 |
| `agent.cancelled`, `agent.failed` | `{ error? }`                                                                          |
| `queue.paused`                    | `{ reason?: 'storage_low' }`                                                          |
| `queue.resumed`                   | `{}`                                                                                  |
| `queue.updated`                   | `{}`: the Thread's `activePromptId` changed                                           |
| `history.truncated`               | `{ afterSequence }`: the marker of a rewind                                           |

The executor writes every other event through its session. The `pending`
projection folds `prompt.accepted`, `prompt.edited`, `prompt.queued`,
`prompt.started`, `agent.started`, `prompt.finished`, `prompt.steered`,
`prompt.paused` and `prompt.resumed` ([`store/progress.ts`](src/host/store/progress.ts)):
only `prompt.finished` closes a turn; `prompt.steered` closes a steering input;
a steering input that `prompt.queued` returns becomes a queued input at the
front; a `user` (or source-less) input that is not queued supersedes every
paused prompt of the Thread.

The usage projection stored in the Thread document's `usage` is
([`store/usage.ts`](src/host/store/usage.ts)):

```ts
interface UsageState {
  completed: UsageTotals; // { calls, unpricedCalls, cost, inputTokens, outputTokens, cachedInputTokens, reasoningTokens }
  current?: {
    inputTokens?;
    outputTokens?;
    cachedInputTokens?;
    reasoningTokens?;
    cost?;
  }; // the call in flight
  context?: ContextUsage; // { model, providerId?, contextWindowSource?, contextWindow?, inputTokens? }
}
```

It folds three event types:

- `response.started` adds the call in flight to `completed`, opens an empty
  `current`, and sets `context` from `model`, `providerId` and a non-zero
  `contextWindow` (keeping the old `context` fields when model and provider
  are the same). Without a string `model` it only closes the call in flight.
- `usage` reads `usage.{inputTokens, outputTokens, cachedInputTokens,
reasoningTokens, cost}`, and `response.finished` reads the same fields of
  `finish.usage`. Each replaces the matching field of `current`, so repeated
  snapshots of one call never charge twice; `inputTokens` also updates
  `context.inputTokens`. Both are ignored without an open `current`.
- A cost counts only when `cost.unit === 'credits'`, from `cost.amount`; a
  call without one counts in `unpricedCalls`. Only finite, non-negative numbers
  are read.

Every string written is made storable: U+0000 and unpaired surrogates become
U+FFFD ([`store/records.ts`](src/host/store/records.ts)).

## Behavior

### Projects

- **Create.** `createProject` stores a `queued` Project with a random palette
  color, the configuration snapshot and this process as its owner, publishes it,
  and starts its sandbox acquisition in the background
  ([`service.ts`](src/host/domain/service.ts), [`colors.ts`](src/host/domain/colors.ts)).
- **Acquire.** The runtime acquires the sandbox with the Project id as identity,
  applies the Git credentials, probes in one command every Thread `cwd` that is
  not the workspace root, then, under the Project lock, records the lease, sets
  the Project `ready`, resets each `cwd` the sandbox no longer holds to the
  root (clearing its hint), sets every live Thread `ready` and starts its queue.
  A failed acquisition ends the Project with `sandbox_acquisition_failed`. A
  probe that cannot run keeps every directory ([`cwd.ts`](src/host/domain/cwd.ts)).
- **Terminate.** The Project goes `cancelling`, every running prompt is aborted
  and every Thread closes (see [Threads](#threads)); once the acquisition, the
  runs and the closes settle, the lease is released, the owner cleared, and the
  Project becomes `cancelled`, or `failed` with the release failure
  `sandbox_release_failed` or the closing failure. A Project with no live
  runtime is loaded from storage and ended the same way.
- **Delete.** Only a terminal Project whose Threads are all terminal is deleted
  (else `active`): one commit removes the Project, its Threads, their history
  parts, attachment records and event streams; the runtime then publishes each
  `threadDeleted` and the `projectDeleted`, and discards the sandbox identity (a
  failed discard is logged). A deletion larger than the storage batch limit
  writes nothing: the backend's `limit_exceeded` error is logged ("Deletion
  exceeds the storage batch limit") and `deleteProject` rejects with it.
- **Rename and color.** `renameProject` and `setProjectColor` write the field
  and publish the record. The runtime stores names as given; callers validate
  them ([`store/projects.ts`](src/host/store/projects.ts)).
- **State writes.** A write to `ready`, `running` or `queued` never leaves
  `cancelling` or a terminal state; no write leaves a terminal state. `ready`
  sets `startedAt` once; `failed` and `cancelled` set `finishedAt`
  ([`store/projects.ts`](src/host/store/projects.ts), [`store/records.ts`](src/host/store/records.ts)).
- **Lists.** `projects` and `threads` are newest first by `createdKey`; a
  `limit` that is not a positive safe integer throws `TypeError('Invalid page limit.')`;
  `nextCursor` is present only when another page exists, and is then the id of
  the last item; an unknown cursor answers an empty page
  ([`store/records.ts`](src/host/store/records.ts)).

### Threads

- **Create.** `createThread` needs a live Project runtime (`missing` for no
  Project, `inactive` otherwise) and a parent that is live and not
  `cancelling`, `failed` or `cancelled`. The new Thread starts `queued`, or
  `ready` when the Project holds a lease; a child starts in its parent's `cwd`
  with its hint ([`runner.ts`](src/host/domain/runner.ts),
  [`store/threads.ts`](src/host/store/threads.ts)).
- **Rename** writes the name and publishes the record.
- **Terminate.** Every descendant is marked closing before any await; running
  prompts are aborted; `onThreadsClosingHook` runs while the runtime waits up to
  1 s for the aborted runs to record their end; then each Thread is written
  `cancelling`, each queued prompt finishes `cancelled` ("The prompt was
  cancelled.") with `agent.cancelled`, and the Thread becomes `cancelled`. A
  close with a failure code finishes the queued prompts `failed` ("The project
  is unavailable.") and the Thread becomes `failed` with that code.
- **Delete.** `deleteThread` answers `forbidden` for an agent Thread that is not
  archived, `active` when the Thread or a descendant is not terminal, and
  otherwise deletes the Thread and its subtree in one commit, as a Project
  delete does, rejecting with `limit_exceeded` the same way
  ([`service.ts`](src/host/domain/service.ts)).

#### Execution: provider, model and effort

([`execution.ts`](src/contracts/execution.ts),
[`runner.ts`](src/host/domain/runner.ts),
[`domain/execution.ts`](src/host/domain/execution.ts))

- A top-level Thread stores the workspace default `models.execution`
  (`providerId`, `model`, and `effort` only when it is a `ReasoningEffort`). A
  reader's child stores its parent's execution, as `resolveThreadExecution`
  resolves it. Creation rejects with the configuration's error when the
  configuration cannot be read, creating nothing.
- `resolveThreadExecution(thread, configuration)`: a Thread without
  `providerId` resolves to the default's provider with `thread.model ??
default.model` and `thread.effort ?? default.effort` (`source: 'default'`); a
  Thread with `providerId` but no `model` is `unavailable` (`issue: 'model'`,
  `model: ''`); a provider the configuration lacks, or a model a listing
  provider does not list, is `unavailable` with that issue; otherwise it is
  `resolved` with the stored values (`source: 'thread'`), without the default's
  effort.
- `checkThreadExecution` (host only): `provider` when no provider has the id;
  `model` when the provider lists models and none has the name; `effort` when an
  effort is given and the model's entry lists `reasonings` that do not include
  it. A provider that lists no models accepts any model and effort.
- `modelEfforts` is the entry's `reasonings` that are `ReasoningEffort`s, in
  order; `modelDefaultEffort` is its `defaultEffort` when it is one of them;
  `modelStartEffort` is `undefined` with no efforts, else the default effort
  when it is not `none`, else the first effort that is not `none`, else the
  first.
- **Spawn rules.** A child always runs on its parent's provider. Without a
  `model`, or with the parent's own model, it keeps the parent's model and
  effort, with the spawn's `effort` over it when given. With another model it
  takes the given `effort`, else `modelStartEffort`. When the spawn names a
  `model` or `effort`, the validator checks it: `provider` always counts,
  `model` and `effort` only when the spawn named them; then `models/v1.resolve`
  must accept the provider and model. A refusal rejects with
  `ContractError('invalid_execution', message, { issue })`, whose message is,
  by issue, `Provider "<providerId>" is not configured.`,
  `Model "<model>" is not available on provider "<providerId>". Available models: <names, comma-separated>.`
  or
  `Effort "<effort>" is not supported by model "<model>". Supported efforts: <reasonings, comma-separated>.`;
  a `resolve` rejection is passed through unchanged. The
  `agent` is never inherited.
- `setThreadExecution` validates the same way with `model` and `effort` both
  counted, answers `invalid` or `unresolvable` without writing, and otherwise
  writes provider, model and effort in one write (an absent `effort` removes
  the stored one) and publishes the Thread. For a well-formed input, it rejects
  only when the configuration cannot be read or the storage read or write of
  the Thread fails ([`service.ts`](src/host/domain/service.ts)). A running
  prompt keeps the execution it started with.

#### Prompts and the queue

([`runner.ts`](src/host/domain/runner.ts),
[`service.ts`](src/host/domain/service.ts),
[`store/queue.ts`](src/host/store/queue.ts))

- **Accept.** `prompt` (reader), `send` and `spawn` (parent), `retry`, `rewind`,
  `restart`, delegated results and terminal results enqueue an input: one
  commit appends `prompt.accepted` (and `prompt.queued` when it waits behind
  others), redacted. An empty prompt throws `TypeError('A non-empty prompt is required.')`.
  Before `prompt`, `retry`, `steer`, `instruct` and `resume` enqueue, a Project
  with no live runtime is brought back from storage and waits for its
  acquisition; before the reader's inputs, `rewind` and `resumeQueue`, the
  sandbox catches up with the current Git credentials.
- **Run.** Each Thread runs one prompt at a time, in queue order. A Thread
  starts its next prompt only when it is not closing, its queue is not paused,
  no storage pause is pending, the Project holds a lease and a prompt waits.
  The run checks storage health, sets the Thread `running` with the prompt as
  `activePromptId`, records the executor's checkpoint, appends
  `prompt.started`, awaits `onPromptStartedHook` outside the lock, binds the
  prompt's `Host` facade and sandbox, and calls `executor.run`. A history in a
  format the executor does not read fails before any model call. At the end it
  appends `prompt.finished` with `status` (`completed`, `failed` or
  `cancelled`) and the text, stores the `result`, returns untaken steers to the
  front of the queue, sets the Thread `ready` and re-reads its repository hint.
  A run takes the Project lock only for its queue and state mutations, and
  never holds it across `executor.run` or an awaited hook. Two other paths
  hold it longer: `setCwd` runs its sandbox commands under it (see below), and
  `withThread` with `exclusive: true` runs the caller's task under it
  ([`service.ts`](src/host/domain/service.ts)).
- **Delegation.** When a prompt whose source is `parent` finishes, the parent
  receives, as a steer of its running prompt or as a queued input, the text

  ```text
  # Delegated task result

  Child thread: <threadId>
  Child prompt: <promptId>
  Originating prompt: <requestPromptId>
  Status: <status>

  ## Result

  <text, redacted>
  ```

  with source `{ kind: 'result', threadId, promptId, requestPromptId }`
  ([`prompts.ts`](src/host/domain/prompts.ts)). Nothing is delivered to a
  closing parent.

- **Steer and instruct.** `steer` sends the reader's input into the running
  prompt `promptId` (`steered`); the executor takes it in at its next safe
  point, after the tool batch in flight or before its final answer would end
  the turn, and `interrupt: true` aborts the current step so the prompt
  continues with the steer at once. Input for a prompt that is no longer
  running, or for a Thread that is stopping or paused, is queued at the front
  (`queued`). `instruct` does the same for a bundle, against `promptId` or the
  prompt running now, and queues when nothing runs.
- **Terminal results.** `enqueueTerminalResult` delivers a background
  terminal's redacted text, source `{ kind: 'terminal', terminalId, promptId }`,
  under the Project lock, unless the Project or Thread is closing. A failed
  delivery, and `failTerminalResult`, log `Terminal result delivery failed` and
  close the Thread with `terminal_result_failed`.
- **Pause (the reader's stop).** `pause` sets `queuePaused` (`queue.paused`)
  and aborts the running prompt, which finishes `cancelled` with the text "The
  prompt was interrupted." and `result.reason: 'interrupted'`; the queue stays
  until `resumeQueue`. `pause` on a paused queue answers `interrupted`.
- **Resume the queue.** `resumeQueue` answers `busy` while a prompt runs,
  `storage_low` when storage is still low, and otherwise rebuilds the queue from
  the durable unfinished prompts (the latest paused one first, appending
  `prompt.resumed` for each paused prompt), appends `queue.resumed`, sets the
  Thread `ready` and starts it. `resume({ id, promptId })` takes up that
  unfinished prompt (`unknown_prompt` when it is not one), through
  `resumeQueue` when the queue is paused.
- **Retry.** `retry` enqueues the Thread's last accepted prompt again, with its
  own text and source, read from the log; it works on agent Threads. With no
  prompt it answers `inactive`.
- **Edit and remove.** A queued prompt is `editable` when its source is `user`,
  it has not started, is not paused and is not superseded. `editQueued` checks
  `revision` (`conflict` when the prompt changed), appends `prompt.edited` and
  answers the new `QueuedPrompt`. `removeQueued` finishes the prompt
  `cancelled` with empty text and `reason: 'queue_removed'`; a running input
  answers `busy`.
- **Queue snapshot.** `queue` answers the running prompt as `current` (else the
  `resumable` one), the latest prompt paused by the reader or by storage as
  `resumable`, and the other unfinished, non-superseded prompts in order
  (`first` ones first, then by `queuedSequence`); a terminal or `cancelling`
  Thread answers an empty, unpaused queue.
- **Rewind.** `rewind` answers `busy` while a prompt runs or waits, asks the
  executor for the truncated state of `promptId` (`unknown_prompt` without a
  boundary), drops the later entries, appends `history.truncated`, keeps the
  usage already charged, and enqueues `prompt` as a reader's input
  ([`store/threads.ts`](src/host/store/threads.ts), [`store/usage.ts`](src/host/store/usage.ts)).
  The contract does not check that `prompt` is non-empty: an empty one still
  truncates the history and appends `history.truncated`, then rejects with
  `TypeError('A non-empty prompt is required.')` and enqueues nothing. Only the
  REST route refuses an empty rewind prompt before the call
  ([`routes/threads.ts`](../../foundation/transport/src/host/routes/threads.ts)).
- **Compact.** `compact` runs on an idle Thread only (`busy` otherwise) with a
  `promptId` of its own and no sandbox binding; it answers `not_supported` when
  the executor does not read the Thread's history format, and otherwise the
  executor's answer.

#### Working directory and repository hint

([`runner.ts`](src/host/domain/runner.ts),
[`cwd.ts`](src/host/domain/cwd.ts),
[`repository-hint.ts`](src/host/domain/repository-hint.ts))

- `setCwd` (the prompt's `cwd` tool) and `setThreadCwd` (the reader) apply one
  rule: an absolute path stands alone, a relative one resolves against the
  current directory like `cd`, and the result is normalized. A path that leaves
  the sandbox root, lexically or through a symbolic link (`pwd -P`), is
  `outside`; a missing one is `missing`; a file is `not-directory`. The whole
  move runs under the Project lock: the path-kind check, the `pwd -P` check,
  the hint probe and the write of the directory with its hint. A hint probe
  that does not finish (time-out or non-zero exit) stores no hint and the move
  succeeds; a sandbox command that throws rejects the move. After the lock,
  `onThreadCwdChangedHook` is awaited before the move answers.
- The hint is `git` when the directory's own root holds a `.git` marker (a
  directory or a file), `github` when its `origin` names github.com in `https`,
  `ssh` or scp-like form, and absent otherwise. The probe runs for at most 5 s.
  The runtime re-reads it after each run, on `location()`, and on `withThread`
  with `refreshHint`; that re-read probes outside the Project lock, writes
  under it only if the Thread still has the directory it probed, and keeps the
  stored hint when the probe fails for any reason.

#### Archive

([`archive.ts`](src/host/domain/archive.ts),
[`archiver.ts`](src/host/domain/archiver.ts))

- The archiver sweeps the live Projects of its process 10 s after the end of
  each sweep, skipping a Project live here for less than 30 s, decides again
  under the Project lock from storage, and writes each due group in one commit
  with a new batch id; it keeps each Thread's `updatedAt` and publishes each
  record. A failed sweep is logged and retried by the next one.
- **Agent rule** (`threads.autoArchive.agentThreads`, default on): an agent
  Thread with a parent that is not archived or pinned, is `ready` or
  `cancelled`, has no paused queue, no question form in its result, is not busy
  or viewed, has a `completed` result (or `cancelled` without
  `reason: 'interrupted'`), and has ended a turn after its last restore, is
  archived 30 s after the later of its result and its last view.
- **Main rule** (`threads.autoArchive.mainThreadsAfter`: `1d`, `7d` (default),
  `30d` or `never`): a root Thread and its non-archived descendants are archived
  together once that time has passed since the latest `createdAt`, `result.at`
  or `restoredAt` of the subtree, when no Thread of it is pending: `queued`,
  `running`, `cancelling` or `failed`, paused, with a question form, busy,
  viewed, pinned, with a `failed` or interrupted result, with a result newer than
  its last view, or restored without a turn since.
- **Manual.** `archiveThread` answers `already_archived` or `busy` (queued,
  running, cancelling, or holding jobs, an active prompt or a storage pause) for
  the target, and otherwise archives it with every descendant that is not
  archived, busy or pinned, failed and cancelled ones included.
  `restoreThread` un-archives the target and its descendants carrying `batch`
  (else the target's own batch), never an ancestor, and sets `restoredAt`.
  `setThreadPinned` writes or removes `pinned`. These keep `updatedAt`.
  `archiveThread` and `restoreThread` write in one commit; over the storage
  batch limit they write nothing, log "Archive (or Restore) exceeds the storage
  batch limit" and reject with `limit_exceeded`. The archive sweep logs the
  same refusal ("Auto-archive exceeds …") and does not reject: it logs any
  other failure as "Auto-archive failed".
- New input to an archived Thread un-archives it first; a failed restore is
  logged and the input proceeds.
- A view's first start and last end each write `viewedAt` without blocking the
  caller. On drain, every view ends with `unavailable` and later views end at
  once.

### Sandboxes and Git credentials

([`service.ts`](src/host/domain/service.ts),
[`git-credentials.ts`](src/host/domain/git-credentials.ts))

- The Git identity is the `GIT` secret named by `gitCredentialId`, else the only
  `GIT` secret; it is applied with `git config --global user.name`/`user.email`.
- The GitHub token is the `API_TOKEN` secret named by `githubCredentialId`, else
  the only `API_TOKEN` secret that no configured provider names in a secret
  field. It is applied with `credential.helper store`, a `~/.git-credentials`
  line `https://<username>:<token>@github.com`, and `~/.config/gh/hosts.yml`
  for `github.com`, both written with `umask 077`; the username is the
  identity's, else `oauth2`. The token reaches the sandbox only through the
  process environment (`DORIC_GIT_CREDENTIAL`, `DORIC_GH_TOKEN`,
  `DORIC_GH_USERNAME`), never argv, and is added to the redaction list.
- Credentials are applied at each acquisition and re-applied before new input
  when they changed; a missing or ambiguous credential, or a failed write, is a
  warning naming the Project and never fails a prompt.

### Redaction

The redaction list is the secrets store's `redactions()` followed by every
secret the runtime wrote into a sandbox. Every event, history part, delegated
result and terminal result is redacted before it is stored: each literal
occurrence becomes `[REDACTED]`; values become cycle-safe JSON
([`redactor.ts`](src/host/domain/redactor.ts),
[`serialization.ts`](src/host/domain/serialization.ts)).

### Storage pressure

([`storage-pressure.ts`](src/host/domain/storage-pressure.ts),
[`storage-pause.ts`](src/host/domain/storage-pause.ts))

- Storage is low when `storage/v1.health()` reports no disk, no blocks, or
  available blocks at or below 10 % of the total, or when the check fails. A
  run checks before it starts and every 3 s while it runs; an error that carries
  `ENOSPC`, PostgreSQL `53100` or "no space left on device" counts too.
- Low storage pauses the Thread: the run is aborted, the Thread reads `ready`
  with `queuePaused` and `errorCode: 'storage_low'`, the failed checkpoint is
  kept in memory, and `queue.paused` and `prompt.paused` (`storage_low`) are
  appended once storage accepts them. `thread` shows this overlay before it is
  durable; `resumeQueue` writes the kept checkpoint first and answers
  `storage_low` while storage is still low.
- Any other persistence failure of a run closes the Thread with
  `persistence_failed` and finishes its prompt `failed` ("Thread persistence
  failed."); no further prompt runs on stale history.

### Recovery, host stop and handover

([`lifecycle.ts`](src/host/lifecycle.ts),
[`handover.ts`](src/host/handover.ts),
[`service.ts`](src/host/domain/service.ts),
[`store/threads.ts`](src/host/store/threads.ts),
[`store/projects.ts`](src/host/store/projects.ts),
[`prompts.ts`](src/host/domain/prompts.ts))

- **Start step.** On `onHostStartHook` the runtime reports the startup stage
  `workspace_reconciliation`, logs "Reconciling persisted projects and
  threads", runs `recover`, and logs "Workspace reconciled" with the counts.
- **Recover.** For every open Thread of an included Project, a started prompt
  without a pause gets `prompt.paused` (`host_restarted`); a `cancelling` Thread
  becomes `cancelled`; any other non-terminal Thread becomes `ready` with no
  active prompt, and its `errorCode` is cleared unless it is `storage_low`. Projects: `cancelling` becomes
  `cancelled`, any other open Project `queued`, errors cleared. Then every
  unfinished prompt the host owes a run (not superseded, not paused by the
  reader or by storage, its Thread's queue not paused) is resumed in accepted
  order, with `prompt.resumed`; a prompt already resumed twice is closed
  `failed` with `resume_exhausted` instead: its `agent.failed` event carries
  `{ name: 'ResumeExhaustedError', code: 'resume_exhausted', message: 'The run
was interrupted three times by a host restart and was not resumed again. The
work may be incomplete; send the prompt again to continue.' }` and its
  `prompt.finished` is `failed` with "The prompt failed."
  ([`prompts.ts`](src/host/domain/prompts.ts),
  [`store/threads.ts`](src/host/store/threads.ts)). Then every non-terminal,
  non-`cancelling` Project is brought back and starts its acquisition.
- **Host stop.** On `onHostStopHook`, `dispose` suspends every live Project: the
  running prompt is paused (`prompt.paused`, `host_stopped`) and stays
  unfinished, queued input stays accepted, each Thread is written `ready`, the
  lease is released and the Project is written `queued` (with
  `sandbox_release_failed` when the release failed). After `dispose`, no
  Project is created and none comes back.
- **Generations.** The runtime runs in every generation process and records
  its `{ generation, incarnation }` as the owner of each Project it holds. When
  a generation becomes active, it recovers in the background with the draining
  processes as `live`, leaving the Projects they own in standby; operations on a
  standby Project wait for its adoption. A generation that starts draining takes
  the work hold `runtime.drain`, lets each Project's running and queued prompts
  finish, closes its Threads' terminals, releases its lease and owner, and
  signals `runtime.released` with the Project id; the hold ends when the drain
  ends. The active runtime adopts on each `runtime.released` signal from the
  `runtime` bundle and on each loss or stop of another generation. Without
  `doric.generation/v1`, no owner is recorded.

### Notices

The runtime publishes each notice after its commit, synchronously, to every
`watch` listener in registration order; a listener that throws is logged and
never reaches the domain ([`notices.ts`](src/host/domain/notices.ts)).

### Usage

`usage` answers the Thread's usage projection with its descendants; when the
context has no `contextWindow`, and exactly one configured provider of kind
`openrouter` matches the context's provider (or lists its model), the runtime
fills `contextWindow` from that provider's catalog with
`contextWindowSource: 'catalog'`; any failure keeps the stored answer
([`usage-context.ts`](src/host/domain/usage-context.ts)).

## Client part: the records mirror

([`src/client/records.ts`](src/client/records.ts),
[`api/workspace-api.ts`](src/client/api/workspace-api.ts),
[`api/project-watch.ts`](src/client/api/project-watch.ts),
[`api/thread-views.ts`](src/client/api/thread-views.ts),
[`domain/tree.ts`](src/client/domain/tree.ts),
[`follow.ts`](src/client/follow.ts),
[`stores/records.ts`](src/client/stores/records.ts))

- **Reads** answer from memory. The first `projects()` call starts the load of
  every Project page (100 per page) and answers `loading`; the first
  `threads(projectId)` call starts the load of that Project's Threads, and
  once it answers, the mirror holds that Project's Threads (`thread(id)` reads
  only Threads of such Projects); from then on its read is kept current. A failed load
  answers `failed` with the rejection as `error` and keeps the last value. A
  read's answer stays the same object while it does not change.
- **Follow.** `follow` keeps one watch of `runtime/v2.watchProject` per Project,
  counted per caller; every subscription delivers a fresh snapshot that replaces
  the Project's Threads. A stream that fails ends the read with
  `project_stream_failed`, "The Project event stream failed."; a dropped
  connection (`disconnected`, `unavailable`, `generation_lost`) subscribes again
  when the connection reports `connected`, or after 1 s when it never dropped.
- **Writes** run the window's payload guards (names: no NUL, trimmed, 1–80
  code points; identifiers: 1–200 characters, no NUL; colors from the palette;
  ids are UUIDs), call the host, and put the answer into the mirror before they
  resolve. A refusal rejects with a `ClientError` carrying the REST message of
  that outcome; a host failure keeps its `ContractError` code (`internal`
  otherwise), with "Doric backend is unavailable." for `unavailable`,
  `disconnected` and `generation_lost`. A delete answered `active` is retried
  every 500 ms; `forbidden` rejects with `conflict`, "An agent opened this
  Thread, so it cannot be deleted until it is archived."; `missing` rejects with
  `not_found`.
- **Views.** `view` holds one `viewThread` stream per Thread on screen and opens
  it again after a silent end; it reports no failure.
- `findThread` and `activity` ask the host once and change no read.
  `connection` follows `doric.connection/v1`. Deactivation ends every watch and
  view.

`runtime/testing` ([`src/testing.ts`](src/testing.ts)) offers
`createRecordsApi(options?)` and `createRecordsFake(options?)`, an in-memory
`runtime.records/v1` with no host, watch or timer. `RecordsFakeOptions` holds
`projects`, `threads`, `activity`, `connection` (`connected` by default),
`pending` and `failing` (of `RecordsOperation`: `projects`, `threads`,
`activity`, `findThread`). A read answers `ready` from the options unless it is
pending (`loading` for good) or failing (`failed`, code `unavailable`, "The
host is unreachable."); a write changes the records and calls the subscribers.

## Configuration

The runtime reads the configuration in force from `host-config/v1` at each use
([`ports.ts`](src/host/ports.ts)):

| Key                                                                                                             | Use                                                                                         | Default                               |
| --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- | ------------------------------------- |
| `models.execution` (`providerId`, `model`, `effort?`)                                                           | The execution a top-level Thread stores, and the fallback of a Thread without `providerId`. | none                                  |
| `providers[]` (`id`, `kind`, `models[].name`, `models[].reasonings`, `models[].defaultEffort`, `configuration`) | Execution validation, spawn efforts, claimed credentials, context capacity.                 | none                                  |
| `execution.contextCompaction.tailMinMessages`                                                                   | Compaction policy passed to the executor.                                                   | `6`                                   |
| `execution.contextCompaction.summaryMaxChars`                                                                   | Compaction policy passed to the executor.                                                   | `6000`                                |
| `threads.autoArchive.agentThreads`                                                                              | Agent archive rule ([`archive.ts`](src/host/domain/archive.ts)).                            | `true`                                |
| `threads.autoArchive.mainThreadsAfter`                                                                          | Main archive rule: `1d`, `7d`, `30d`, `never` ([`archive.ts`](src/host/domain/archive.ts)). | `7d`                                  |
| `gitCredentialId`                                                                                               | The Git identity secret ([`git-credentials.ts`](src/host/domain/git-credentials.ts)).       | the only `GIT` secret                 |
| `githubCredentialId`                                                                                            | The GitHub token secret ([`git-credentials.ts`](src/host/domain/git-credentials.ts)).       | the only unclaimed `API_TOKEN` secret |

The runtime reads no environment variable of its own.

## Limits

| Limit                            | Value                                                                                                                  | Where                                                                                    |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| Name length                      | 80 code points                                                                                                         | [`model.ts`](src/contracts/model.ts)                                                     |
| Agent instructions               | 64 000 characters                                                                                                      | [`threads.ts`](src/contracts/threads.ts)                                                 |
| `instruct` reason                | 1–64 characters                                                                                                        | [`threads.ts`](src/contracts/threads.ts)                                                 |
| Attachment size                  | 5 MiB                                                                                                                  | [`attachments.ts`](src/contracts/attachments.ts)                                         |
| Attachment name                  | 200 characters                                                                                                         | [`attachments.ts`](src/contracts/attachments.ts)                                         |
| Automatic resumes of one prompt  | 2; the third interruption closes it                                                                                    | [`prompts.ts`](src/host/domain/prompts.ts)                                               |
| Wait for aborted runs on close   | 1 s                                                                                                                    | [`runner.ts`](src/host/domain/runner.ts)                                                 |
| Storage check while running      | every 3 s; low at ≤ 10 % free blocks                                                                                   | [`storage-pressure.ts`](src/host/domain/storage-pressure.ts)                             |
| Repository hint probe            | 5 s                                                                                                                    | [`repository-hint.ts`](src/host/domain/repository-hint.ts)                               |
| Archive sweep                    | 10 s after the previous one; Projects live ≥ 30 s; agent delay 30 s                                                    | [`archiver.ts`](src/host/domain/archiver.ts), [`archive.ts`](src/host/domain/archive.ts) |
| Storage page reads               | at most 1000 entries per read                                                                                          | [`store/documents.ts`](src/host/store/documents.ts)                                      |
| Queue preview                    | 240 characters                                                                                                         | [`store/queue.ts`](src/host/store/queue.ts)                                              |
| One deletion, archive or restore | one storage commit; over the batch limit nothing is written and the method rejects with the backend's `limit_exceeded` | [`service.ts`](src/host/domain/service.ts)                                               |

## Errors and failure behavior

- Contract outcomes are values (`missing`, `inactive`, `busy`, `forbidden`…),
  not rejections; `restErrors` maps each to its REST status, code and message
  ([`rest-errors.ts`](src/contracts/rest-errors.ts)).
- Rejections: `ContractError('invalid_input' | 'unavailable' | 'not_found' | 'internal' | 'replay_failed' | 'invalid_execution')`
  as listed per contract; `Error('Thread control is no longer active.')`;
  `Error('Doric is shutting down.')`; `TypeError` for an empty prompt or title
  and an invalid page limit; input validation errors for inputs that fail a
  method's schema; the storage backend's `limit_exceeded` error from
  `deleteProject`, `deleteThread`, `archiveThread` and `restoreThread` when
  their one commit is over the batch limit
  ([`service.ts`](src/host/domain/service.ts)); and the sandbox's own error
  from `setThreadCwd` and the prompt's `setCwd` when a command of the move
  throws ([`runner.ts`](src/host/domain/runner.ts)).
- Error codes on records: `sandbox_acquisition_failed`,
  `sandbox_release_failed`, `persistence_failed`, `terminal_result_failed`,
  `storage_low` (Threads and Projects); `resume_exhausted` on a prompt failure
  ([`service.ts`](src/host/domain/service.ts),
  [`store/threads.ts`](src/host/store/threads.ts),
  [`storage-pause.ts`](src/host/domain/storage-pause.ts),
  [`prompts.ts`](src/host/domain/prompts.ts)).
- Failures that never fail the operation that caused them: hook handlers,
  credential application, sandbox discard, notice listeners, the post-run
  repository-hint re-read, view writes and archive sweeps; each is logged
  ([`ports.ts`](src/host/ports.ts),
  [`git-credentials.ts`](src/host/domain/git-credentials.ts),
  [`notices.ts`](src/host/domain/notices.ts),
  [`runner.ts`](src/host/domain/runner.ts),
  [`archiver.ts`](src/host/domain/archiver.ts)). A hint probe inside a move
  is the exception described above.
- Log messages include "Project and thread reconciliation complete",
  "Interrupted prompts resumed", "Project sandbox recovery scheduled", "Thread
  persistence failed", "Storage pause awaits persistence", "Thread history
  format is unsupported" (code `history_format_unsupported`),
  "`<Deletion|Archive|Restore|Auto-archive>` exceeds the storage batch limit",
  "Auto-archive failed", "Generation recovery failed", "Generation drain
  failed", "Project adoption failed" and "Project release signal failed".

## Build and test

The Nx project is `bundle-runtime` ([`project.json`](project.json)):

- `npx nx run bundle-runtime:build`: compiles the host and contracts
  (`tsconfig.json`), checks the client (`tsconfig.client.json`), and builds the
  bundle with `packages/bundle`'s CLI into `dist/`.
- `npx nx run bundle-runtime:typecheck`: the same two compilations, declarations
  only.
- `npx nx run bundle-runtime:test`: builds first, compiles `tests/`
  (`tsconfig.spec.json`) and `tests/client/` (`tsconfig.client-spec.json`, with
  `happy-dom`) into `dist-tests/`, and runs
  `node --test 'bundles/runtime/runtime/dist-tests/tests/**/*.test.js'`.

The store tests ([`tests/store/store.conformance.test.ts`](tests/store/store.conformance.test.ts))
run every case on the memory backend, and on PostgreSQL too when
`DORIC_TEST_DATABASE_URL` names a database: each case creates a fresh schema,
applies the migrations of `bundles/foundation/postgres/prisma/migrations` and
drops the schema at the end ([`tests/store/support.ts`](tests/store/support.ts)).
Run them against PostgreSQL with
`DORIC_TEST_DATABASE_URL=<url> npx nx run bundle-runtime:test`; without the
variable the PostgreSQL cases are skipped.

`tests/contracts/adapter-parity.test.ts` and `tests/runtime-contracts.test.ts`
read the recorded transcript `tests/fixtures/adapter-parity/transcript.json`.
Nothing can record it again: `kernelModules()` of
[`tests/support/capture-adapter.ts`](tests/support/capture-adapter.ts) imports
`app/backend/doric-host/dist-tests/src/lib/workspace/{service,projects,threads}.js`,
`src/lib/bundles/adapter.js` and `tests/helpers/workspace.js`, whose sources do
not exist. So `tests/adapter-capture.test.ts` (which runs only with
`DORIC_TEST_DATABASE_URL` set and `DORIC_TEST_ADAPTER_CAPTURE=true`) and
`main()` of `capture-adapter.ts` both fail with a module-not-found error.
