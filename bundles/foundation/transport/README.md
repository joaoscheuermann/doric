# Transport bundle

`transport` is the Doric host's network API: it serves the `doric.api.*`
services that clients use to create Projects and Threads, send prompts, read
workspace files and diffs, drive terminals, edit the configuration and
credentials, and follow a Thread's events live. Its REST routes and Socket.IO
namespaces were deleted in slice S69. It stores nothing: every answer is the
answer of a contract call to the bundle that owns the data.

The route and event reference, with every path, success status, request rule
and payload a client sees, is the host's:
[REST API](../../../app/backend/doric-host/README.md#rest-api),
[Request rules](../../../app/backend/doric-host/README.md#request-rules),
[Workspace reads](../../../app/backend/doric-host/README.md#workspace-reads),
[Replay](../../../app/backend/doric-host/README.md#replay) and
[Socket.IO](../../../app/backend/doric-host/README.md#socketio). This README
describes what the bundle's code does to serve them. The behavior across
bundles is in the feature docs
[projects and threads](../../../docs/features/projects-and-threads.md),
[credentials](../../../docs/features/credentials.md),
[terminal](../../../docs/features/terminal.md),
[git](../../../docs/features/git.md),
[files](../../../docs/features/files.md),
[cwd tool](../../../docs/features/cwd-tool.md) and
[per-thread model](../../../docs/features/per-thread-model.md). See the
[main README](../../../README.md) for Doric as a whole and
[`packages/bundle`](../../../packages/bundle/README.md) for how bundles work.

## Manifest

[`manifest.json`](manifest.json):

- `manifestVersion`: `1`; `id`: `transport`; `version`: `0.0.2`;
  `engines.doric`: `^1.0.0`;
  `description`: "The host API: the doric.api.\* Connect services."
- `provides`: since slice S62c1, the eight public API contracts
  `api.config/v1`, `api.credentials/v1`, `api.providers/v1`, `api.host/v1`,
  `api.projects/v1`, `api.threads/v1`, `api.terminals/v1` and
  `api.status/v1`, each `@1.0.0`. The bundle defines no slot, tool or hook.
- `requires`: `hooks/v1@^1.1.0`, `runtime/v2@^2.0.0`,
  `runtime.threads/v1@^1.9.0`, `runtime.lease/v1@^1.5.0`, `sandbox/v1@^1.1.0`,
  `tools/v1@^1.6.0`, `models/v1@^1.0.0`, `secrets/v1@^1.3.0` and
  `host-config/v1@^1.0.0`.
- `optional`: `files/v1`, `git.commands/v1`, `usage/v1`, `resources/v1`,
  `terminal/v1` and `log/v1`. The first five are the feature bundles' contracts: the transport
  activates without them, and a disabled or quarantined feature bundle does
  not take it down; the RPCs and the `Watch` reads that call one fail while
  it is absent.

It has one part, the host part ([`src/host/`](src/host)), whose only entry
since slice S69 is the process entry [`src/host/main.ts`](src/host/main.ts).
`package.json` still exports `./kernel` (`src/kernel.ts`, deleted in S69); the
export goes in slice S70.

## Contracts it uses

| Contract                                                                                                                                                                                    | What the transport calls it for                                                                                                                                                                                              |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `hooks/v1`, `doric.app.hooks/v1` ([hooks](../../../docs/architecture/bundles/hooks.md))                                                                                                     | `onHostStartHook`: the startup log line ([`src/host/process/service.ts`](src/host/process/service.ts))                                                                                                                       |
| `doric.startup/v1`                                                                                                                                                                          | `log`: writes the startup log line ([`src/host/process/service.ts`](src/host/process/service.ts))                                                                                                                            |
| `host-config/v1` ([README](../host-config/README.md))                                                                                                                                       | `current`, `replace`: `ConfigService.GetConfig` and `PutConfig`                                                                                                                                                              |
| `secrets/v1`                                                                                                                                                                                | `list`, `kinds`, `create`, `update`, `delete`: `CredentialsService`                                                                                                                                                          |
| `models/v1`                                                                                                                                                                                 | `kinds`, `kind`, `catalog`: `ProvidersService`                                                                                                                                                                               |
| `tools/v1`                                                                                                                                                                                  | `list`: `HostService.ListTools`                                                                                                                                                                                              |
| `sandbox/v1` (declared by [`runtime`](../../runtime/runtime/README.md), provided by [`docker`](../../sandboxes/docker/README.md) or [`firecracker`](../../sandboxes/firecracker/README.md)) | `machines`, `machine`: `HostService.ListVms` and `GetVmSsh`                                                                                                                                                                  |
| `runtime/v2` ([README](../../runtime/runtime/README.md))                                                                                                                                    | Project creation, listing, rename, color, read, terminate and delete; `vmSsh`; `WatchProject` for `ProjectsService.Watch`                                                                                                    |
| `runtime.threads/v1` ([README](../../runtime/runtime/README.md))                                                                                                                            | Every `ThreadsService` Thread and queue RPC, `ProjectsService.CreateThread` and `ListThreads`, and `WatchThread` for `ThreadsService.Watch`                                                                                  |
| `runtime.lease/v1` ([README](../../runtime/runtime/README.md))                                                                                                                              | `ssh`, bound to `{ projectId }`: `ProjectsService.GetProjectSsh`                                                                                                                                                             |
| `files/v1` ([README](../../features/files/README.md))                                                                                                                                       | `directory`, `tree`, `content`, bound to `{ projectId }`: `ProjectsService.ListFiles`, `GetTree` and `ReadFile`                                                                                                              |
| `git.commands/v1` ([README](../../features/git/README.md))                                                                                                                                  | `diff`, `changes`, `fileDiff` bound to `{ projectId }`: `ProjectsService.GetDiff`, `ListChanges` and `GetFileDiff`; `status`, `branches`, `switchBranch` unbound: `ThreadsService.GetGit`, `ListBranches` and `CreateBranch` |
| `resources/v1` ([README](../../features/resources/README.md))                                                                                                                               | `host` unbound for `HostService.ListResources`; `project` bound to `{ projectId }` for `ProjectsService.GetProjectResources`                                                                                                 |
| `usage/v1` ([README](../../features/usage/README.md))                                                                                                                                       | `thread`: `ThreadsService.GetUsage`                                                                                                                                                                                          |
| `terminal/v1` ([README](../../features/terminal/README.md))                                                                                                                                 | `list`, `create`, `snapshot`, `input`, `resize`, `stop`: `ProjectsService.ListTerminals`, `ThreadsService.CreateTerminal` and `TerminalsService`; `WatchProject`: the terminal items of `ProjectsService.Watch`              |

`secrets/v1`, `models/v1` and `tools/v1` are basic contracts of
`bundle/contracts`, provided by [`core`](../core/README.md)
([basic contracts](../../../docs/architecture/bundles/contexts.md#the-basic-contracts)).

## REST and Socket.IO, removed (slice S69)

Slice S69 deleted the kernel path of this bundle: `src/kernel.ts`
(`createTransport`, `transportRequires`), `src/host/{index,app,errors,services}.ts`
(the `doric.network/v1` registration, `TransportServices`, the Express mount
order and `handleHttpError`), the routers `src/host/routes/` and the Socket.IO
namespaces `src/host/sockets/` (`/status`, `/projects`, `/threads`), and
`sendAnswer` with the `express` import of
[`src/host/api/answer.ts`](src/host/api/answer.ts). The bundle serves only the
`doric.api.*` services of [its process part](#the-process-part-slices-s60c-s60d).

- **Operations.** Each RPC body is an operation of
  [`src/host/api/operations/`](src/host/api/operations) (`config`,
  `credentials`, `providers`, `host`, `projects`, `threads`, `terminals`) over
  `TransportPorts` ([`src/host/api/ports.ts`](src/host/api/ports.ts), which
  also exports `LeaseScope`, `{ projectId }` or `{ threadId }`, and
  `ProjectScope`, `{ projectId }`). An operation returns an `ApiAnswer`
  ([`src/host/api/answer.ts`](src/host/api/answer.ts)): `apiError` turns a
  REST refusal into a `ContractError`; `apiFailure` passes `unavailable`,
  `generation_lost`, `limit_exceeded`, `deadline_exceeded` and `cancelled`
  through, reading a `ConnectError` as well as a `ContractError`, and turns any
  other failure into `internal_error`; `answerValue` unwraps an answer;
  `routeInputOf` decodes a message through `runtime/contracts` `decode`. The
  credential body schemas `CredentialCreateSchema` and
  `CredentialUpdateSchema` live in `operations/credentials.ts`.
- **Inputs.** [`src/host/api/input.ts`](src/host/api/input.ts) holds the
  input schemas and answers the operations share: `pageInput` (`limit` 50 by
  default, 1 to 100; `cursor` a UUID), `nameInput` (a normalised name, empty
  refused), `ok` (status 200 unless one is given) and `refused`.

[Common rules](#common-rules) states how the operations refuse today. The
sections [Routers](#routers) and
[Socket.IO behavior](#socketio-behavior) below describe the removed surface.
Their refusal codes, messages and payload rules are those the operations and
the `Watch` streams still answer; the paths, HTTP statuses, headers, body
parser and Engine.IO details left with REST and have no RPC counterpart.

## HTTP behavior

### Common rules

- **Authentication.** No RPC authenticates its caller; the host is kept on a
  trusted network
  ([Network exposure](../../../app/backend/doric-host/README.md#network-exposure),
  [`src/host/api/operations/credentials.ts`](src/host/api/operations/credentials.ts)).
- **Requests.** A request breaking its `.proto`'s protovalidate rules is
  refused before the operation runs, through `invalidApiInput`
  ([`src/host/api/violations.ts`](src/host/api/violations.ts)): a Project,
  Thread or Credential id that is not a UUID answers `invalid_<kind>_id` with
  `The <kind> ID is invalid.`, any other violation the method's own refusal.
  The operation then reads the request as its route read it (`routeInputOf`),
  and its own schemas check it (`pageInput`: `limit` 1–100, default 50, and an optional UUID `cursor`;
  `nameInput`: `normalizeName`, then `isValidName`, both from
  `runtime/contracts`, [`src/host/api/input.ts`](src/host/api/input.ts)).
  `PutConfig` alone hands its configuration unchecked to `host-config/v1`
  ([`src/host/api/operations/config.ts`](src/host/api/operations/config.ts)).
- **Refusals.** An operation refuses with `refused(error)`, a `RestError`
  `{ status, code, message }`, and the RPC ends with `apiError`'s
  `ContractError(code, message)` ([`src/host/api/answer.ts`](src/host/api/answer.ts)).
  For the kinds `project`, `thread` and `credential`, `runtime/contracts`'
  `notFoundError(kind)` is `<kind>_not_found`, `The <kind> was not found.`,
  and `conflictError(kind, reason)` is `<kind>_<reason>`, with
  `storageMessage` when `reason` is `storage_low` and
  `The <kind> cannot perform this operation.` otherwise
  ([`rest-errors.ts`](../../runtime/runtime/src/contracts/rest-errors.ts)).
- **Terminal and VM ids** are not UUIDs, and no rule checks them: an unknown
  one answers `terminal_missing` or `vm_not_found` where the operation reads
  it, and `TerminalsService.DeleteTerminal` succeeds for any id
  ([`src/host/api/operations/terminals.ts`](src/host/api/operations/terminals.ts),
  [`src/host/api/operations/host.ts`](src/host/api/operations/host.ts)).
- **Unexpected failures.** An operation that throws or rejects and a contract
  call that fails end with `apiFailure`: `unavailable`, `generation_lost`,
  `limit_exceeded`, `deadline_exceeded` and `cancelled` pass through, anything
  else answers `internal_error` with `The request could not be completed.`
  and never the underlying message
  ([`src/host/api/answer.ts`](src/host/api/answer.ts),
  [`src/host/process/service.ts`](src/host/process/service.ts)).
- **REST error table.** The answers to the `runtime/contracts` outcomes match
  the table `restErrors` of the `runtime` bundle, which the desktop's adapters
  read; `UpdateThread`'s execution change calls `restErrors.setThreadExecution`
  itself
  ([`src/host/api/operations/threads.ts`](src/host/api/operations/threads.ts),
  [errors of the runtime](../../runtime/runtime/README.md#errors-and-failure-behavior)).

### Routers

Each router validates its input, calls one contract method per step, and maps
the method's outcome to a status. The paths and success statuses are in the
host's [Routes](../../../app/backend/doric-host/README.md#routes) table.

- **Configuration** ([`src/host/api/operations/config.ts`](src/host/api/operations/config.ts)):
  `GET` answers `host-config/v1.current()` unchanged. `PUT` hands the body to
  `replace`: `replaced` answers `200` with the new `config`, `invalid` answers
  `422 invalid_config` with the contract's message, and any other outcome or a
  rejection answers `503 configuration_rejected`
  (`The Doric configuration could not be activated.`).
- **Credentials**
  ([`src/host/api/operations/credentials.ts`](src/host/api/operations/credentials.ts)):
  answers only `secrets/v1`'s descriptions, which never hold a secret. A
  create body (`CredentialCreateSchema`) holds `kind`, a trimmed `name` of
  1–128 characters, and optionally a trimmed `username` (1–128), an `email`
  (at most 256, an address) and a `secret` (1–512, no line break); it must
  name a kind that `secrets/v1.kinds()` lists and satisfy its fields
  (`credentialFieldsSatisfied`). An update body (`CredentialUpdateSchema`)
  takes the same fields, each optional, where `''` clears a stored field and
  `null` keeps it, and a `kind` only to refuse a change of it. A failing body,
  and an update that names a kind no registration lists, answer
  `422 invalid_credential` (`The credential does not match its kind.`). The
  contract errors map:
  `credential_invalid` and `unknown_kind` to `422 invalid_credential` with
  their message, `credential_missing` to `404 credential_not_found`,
  `credential_kind_immutable` and `credential_name_taken` to
  `409 credential_<reason>`, and `credential_storage_unavailable` to
  `503 credential_storage_unavailable`
  (`The host cannot store credential secrets.`); any other error ends with `apiFailure`. `DELETE` answers `missing` with
  `404` and `referenced` with `409 credential_referenced`.
- **Providers** ([`src/host/api/operations/providers.ts`](src/host/api/operations/providers.ts)):
  `GET /providers/kinds` answers `{ kinds }` from `models/v1.kinds()`.
  `POST /providers/models` takes `{ kind, configuration }` (a trimmed kind of
  1–128 characters and a record of strings), looks the kind up with
  `models/v1.kind`, and accepts the configuration when every key is a declared
  field with a non-blank value of its kind (`url`: `http://` or `https://`;
  `number`: finite; `enum`: one of its options; `secret`: a credential UUID;
  `text`: any) and every required field is present; otherwise it answers
  `422 invalid_provider`. It answers `{ models }` when `models/v1.catalog`
  reads them, and `502 model_catalog_unreadable` otherwise.
- **Tools** ([`src/host/api/operations/host.ts`](src/host/api/operations/host.ts)): answers
  `{ tools: [{ name, description, settings }] }` from `tools/v1.list()`;
  listing runs no tool.
- **Resources** ([`src/host/api/operations/host.ts`](src/host/api/operations/host.ts)):
  answers `resources/v1.host()` unchanged.
- **VMs** ([`src/host/api/operations/host.ts`](src/host/api/operations/host.ts)): `GET /vms`
  answers `sandbox/v1.machines()`. `GET /vms/:id/ssh` reads the machine with
  `sandbox/v1.machine` (`404 vm_not_found` when absent), then
  `runtime/v2.vmSsh` (`409 vm_ssh_unavailable` when absent), and answers
  `{ vm, ...access }`. The machines are those of the active generation's
  `sandbox/v1` provider, the `docker` or `firecracker` bundle
  ([sandboxes](../../../docs/features/sandboxes.md)).
- **Projects** ([`src/host/api/operations/projects.ts`](src/host/api/operations/projects.ts)):
  - Creation calls `runtime/v2.createProject` and adds
    `ssh: { href: '/projects/<id>/ssh' }` to the Project; a body without a
    valid name answers `422 invalid_project`. Lists take `pageInput`
    (`400 invalid_page`); the Thread list also takes a UUID `parentThreadId`
    and answers an unknown Project with `404 project_not_found`.
    Rename, color (a palette color of `projectColors`, or `null`;
    `422 invalid_project_color`), read, terminate and delete call the
    matching `runtime/v2` method; delete answers `active` with
    `409 project_active`.
  - Thread creation calls `runtime.threads/v1.createThread` with the name and
    an optional `parentThreadId` (`422 invalid_thread`); `missing` answers
    `404 project_not_found` and any other outcome but `created` answers
    `409 thread_<outcome>`.
  - `GET /projects/:id/ssh` calls `runtime.lease/v1.ssh` bound to the
    Project: `pending` answers `202 { status: 'pending' }` with
    `Retry-After: 1`, `expired` answers `410 project_ssh_expired`, any other
    outcome but `ready` answers `409 project_ssh_unavailable`, and `ready`
    answers the access with `href: '/vms/<vmId>/ssh'`.
  - The workspace reads (`/files`, `/tree`, `/files/content`, `/diff`,
    `/changes`, `/files/diff`, `/resources`) call `files/v1`, `git.commands/v1`
    or `resources/v1` bound to the Project. A query `path` is at most 4096
    characters without NUL (`422 invalid_project_path`); `/files/content`
    requires it, and `/files/diff` requires `repository` and a non-empty
    `path`. The lease outcome maps the same way for all of them
    (`leaseAnswer` of `src/host/api/operations/projects.ts`): `missing` → `404 project_not_found`, `pending` →
    `202 { status: 'pending' }` with `Retry-After: 1`, `expired` →
    `410 project_files_expired`, `unavailable` →
    `409 project_files_unavailable`, and so does any other lease status. A ready read
    answers its value: a listing as `{ path, entries }`, content as
    `{ path, content, truncated, binary }`, a diff or change list as
    `{ path?, repositories }`, a file diff as the diff itself; `not_found`
    answers `404 project_path_not_found` and any other read outcome
    `422 invalid_project_path`. Normalizing a path and bounding content are
    the `files` and `git` bundles' work.
- **Threads** ([`src/host/api/operations/threads.ts`](src/host/api/operations/threads.ts)):
  - `PATCH /threads/:id` takes `name`, `cwd` (non-blank, at most 4096
    characters, no NUL, not trimmed), and an execution (`providerId` and
    `model` together, `providerId` trimmed to 1–128 characters and `model`
    to 1–512, `effort` from `reasoningEfforts` only with them), at least one
    of them (`422 invalid_thread`). It applies them in that order,
    each with its own call (`renameThread`, `setThreadCwd`,
    `setThreadExecution`) and without a transaction: a later refusal keeps the
    earlier changes. A refused `cwd` answers `400 invalid_cwd` with the
    sentence of its reason: `outside`
    (`The working directory must stay inside the workspace.`), `missing`
    (`No such directory.`) or `not-directory`
    (`The working directory must be a directory.`); an
    inactive Thread `409 thread_inactive`; the execution's refusal is the one
    `restErrors.setThreadExecution` gives; a missing Thread answers
    `404 thread_not_found`. It answers the last Thread, and
    `422 invalid_thread` (`A Thread change is required.`) when no step
    produced one.
  - Prompt, steer, resume, rewind and interrupt take strict bodies: `prompt`
    takes `{ prompt }`, `steer` `{ prompt, promptId, interrupt? }`
    (`interrupt` a boolean), `resume` and `interrupt` `{ promptId }`, and
    `rewind` `{ promptId, prompt }`; a `prompt` is a non-blank string and a
    `promptId` a UUID. An invalid body answers `422 invalid_prompt`,
    `invalid_steer`, `invalid_resume`, `invalid_interrupt` or
    `invalid_rewind`. They call the `runtime.threads/v1` methods `prompt`,
    `steer`, `resume`, `rewind` and `pause` (for `interrupt`).
    `prompt` answers `202 { promptId }`; `steer` answers
    `202 { status, promptId }` for `steered` or `queued`; `resume` answers
    `202` with the Thread; `rewind` answers `202 { promptId }`; `interrupt`
    answers `200 { status: 'interrupted' }`. Each answers `missing` with
    `404 thread_not_found`. `resume` and `rewind` answer `unknown_prompt`
    with `404 prompt_not_found`; `rewind` answers `busy` with
    `409 thread_busy`. Any other refusal answers `409 thread_inactive` for
    `prompt`, `steer` and `rewind`, and `409 thread_<outcome>` for `resume`
    and `interrupt`.
  - `compact` answers `200` with `status`, `condensedMessages`,
    `retainedMessages` and `tokensFreed`; `missing` answers
    `404 thread_not_found`, `busy` answers `409 thread_busy`, a
    refusal
    `409 compaction_refused` with the sentence of its reason (`disabled`,
    `missing_history`, `nothing_to_compact`), `failed`
    `502 compaction_failed` naming the failure code, and any other outcome
    but `compacted` `409 thread_<outcome>`.
  - The queue routes call `queue`, `resumeQueue`, `queuedPrompt`,
    `editQueued` and `removeQueued`. A path `promptId` that is not a UUID
    answers `422 invalid_prompt`. `GET /threads/:id/queue` answers `missing`
    with `404 thread_not_found`; `POST /threads/:id/queue/resume` answers
    `missing` with `404 thread_not_found` and any other outcome but
    `resumed` with `409 thread_<outcome>`, and the resumed Thread with `200`;
    `DELETE /threads/:id/queue/:promptId` answers `missing` with
    `404 thread_not_found` and any other outcome but `removed` with
    `409 thread_<outcome>`; `GET /threads/:id/queue/:promptId` answers an
    absent prompt with `404 unknown_prompt`
    (`This prompt is no longer queued.`). An edit takes `{ text, revision }`
    (non-blank text, a non-negative integer revision). An edit
    refusal answers its outcome as the code, unprefixed: `missing` and
    `unknown_prompt` with `404`, `conflict` and `not_editable` with `409`.
  - `GET /threads/:id/events` takes `afterSequence` (a non-negative integer,
    default 0; `400 invalid_event_cursor`) and answers
    `runtime.threads/v1.threadEvents`.
  - `GET /threads/:id/git` and `GET /threads/:id/branches` answer `missing`
    with `404 thread_not_found`, the `git.commands/v1` value when ready,
    `200 { status: 'pending' }` when pending, and
    `200 { status: 'unavailable' }` for any other outcome.
    `POST /threads/:id/branches` takes `{ branch, cwd }` (a branch of 1–1024
    characters, no NUL, not starting with `-`; `cwd` as in the PATCH;
    `422 invalid_branch`); `refused` answers `409 branch_refused` with the
    contract's message, `missing` answers `404 thread_not_found`, and any
    other outcome but `ready` answers `409 thread_inactive`.
  - `GET /threads/:id/usage` answers `usage/v1.thread`, and an absent usage
    with `404 thread_not_found`; read, terminate and
    delete call the matching `runtime.threads/v1` method, and delete answers
    `active` with `409 thread_active`.
- **Terminals** ([`src/host/api/operations/terminals.ts`](src/host/api/operations/terminals.ts)):
  `GET /projects/:id/terminals` answers `{ items }` from `terminal/v1.list`.
  `POST /threads/:id/terminals` takes optional `cols` and `rows` (integers
  1–1000; `422 invalid_terminal`) and answers `201` with the session, or
  `409 terminal_unavailable` when the Thread has no active sandbox.
  `GET /terminals/:id` takes `after` (a non-negative integer, default 0;
  `422 invalid_cursor`) and answers the snapshot. Input takes
  `{ data }` of at most 65536 characters (`422 invalid_input`), resize takes
  both `cols` and `rows` (`422 invalid_size`); both answer `204`, and
  `404 terminal_missing` when the terminal is gone. `DELETE` always answers
  `204`.

## Socket.IO behavior

The events and their payloads are in the host's
[Socket.IO](../../../app/backend/doric-host/README.md#socketio) and
[Subscriptions](../../../app/backend/doric-host/README.md#subscriptions)
sections.

- **`/status`** had no middleware and no event: a connection only confirmed
  that the host is reachable. Its successor, `StatusService.Watch`, sends one
  `ready` item (`statusWatch`,
  [`src/host/process/watch.ts`](src/host/process/watch.ts)).
- **Handshake.** A namespace middleware parses `socket.handshake.auth` only,
  never the query: `/threads` takes `{ threadId: UUID, afterSequence }`
  (a non-negative integer, coerced, default 0) and `/projects` takes
  `{ projectId: UUID }`. A handshake that fails is refused with
  `Invalid thread subscription.` or `Invalid project subscription.`; the
  `Watch` RPCs answer the same sentences as `invalid_input`
  ([`src/host/api/violations.ts`](src/host/api/violations.ts)). This
  checks the subscription's shape; it authenticates no one.
- **Subscribe first, then read.** On connection the socket is added to the
  subscribers of its Thread or Project, not yet ready, before any durable
  read. Notices for it are buffered while it is not ready.
- **Thread snapshot.** `runtime.threads/v1.storedThread` and
  `storedEventsAfter` are read together, then `runtime/v2.project` of the
  Thread's Project. If the socket is still connected, it receives
  `thread:snapshot` with `{ threadId, projectId, project, thread, events }`,
  missing records as `null` and the events after `afterSequence` sorted by
  sequence. The last sequence sent becomes the socket's cursor; the socket
  becomes ready; buffered events, then buffered notices, are sent.
- **Event order.** A live `agent:event` at or below the socket's cursor is
  dropped. Events are kept by sequence and sent only in an unbroken run from
  the cursor: an event after a gap waits until the missing one arrives.
- **Project snapshot.** The terminal stream of the Project is opened, then
  `runtime/v2.project` and `runtime.threads/v1.projectThreads` are read
  together, then `terminal/v1.list`. A connected socket receives
  `project:snapshot` with `{ projectId, project, threads, terminals }` and
  `terminal:snapshot` with `{ projectId, terminals }`, becomes ready, and gets
  its buffered notices.
- **Live notices.** The `runtime/v2` listener turns an `event` notice into
  `agent:event` (the event envelope, under the ordering above) for the
  Thread's subscribers; `threadUpdated` into `thread:updated` (the Thread)
  and `threadDeleted` into `thread:deleted` (`{ projectId, threadId }`) for
  both the Thread's and the Project's subscribers; and `projectUpdated` into
  `project:updated` (the Project) and `projectDeleted` into `project:deleted`
  (`{ projectId }`) for the Project's. It ignores every other notice kind.
  The terminal feed turns `terminal/v1.watchProject` items into
  `terminal:updated` (the session), `terminal:removed` (its `projectId`,
  `threadId` and `terminalId`) and `terminal:output` (the output), and
  ignores its own snapshot item.
- **Terminal output is never buffered:** a socket that is not ready yet does
  not get it, and reads the terminal snapshot instead.
- **Terminal streams.** One `terminal/v1.watchProject` stream is opened per
  subscribed Project and closed when its last socket disconnects. A new
  `terminal/v1` provider reopens the stream of every subscribed Project; a
  provider that leaves closes them; a provider that throws while opening one
  leaves it closed until the next provider.
- **Failure.** A snapshot read that rejects sends `workspace:error` with the
  code `replay_failed` and the message `The snapshot could not be loaded.`,
  and disconnects the socket.
- **Disconnect** removes the socket and drops its buffered events and notices.

## Data and persistence

The bundle persists nothing and keeps no file. Its only state is in memory:
the routed clients, each created at its first call and kept as long as the
process ([`src/host/process/routed.ts`](src/host/process/routed.ts)), and, for
as long as one `ProjectsService.Watch` call, the notices it holds until both
snapshots arrived ([`src/host/process/watch.ts`](src/host/process/watch.ts)).

## Configuration and limits

The bundle reads no setting and no environment variable. Its limits are the
`.proto` files' protovalidate rules, the operations' schemas above, the
`ReadFile` chunks of at most 1,048,576 code units and the `ListThreads` and
`ListEvents` pages under 3 MiB (`API_PAGE_MAX_BYTES`,
[`src/host/process/service.ts`](src/host/process/service.ts)).

## The public API protos

[`proto/doric/api/`](proto/doric/api) holds the eight contracts of the public
API's target shape, `api.<resource>/v1` in the packages
`doric.api.<resource>.v1` for `config`, `credentials`, `providers`, `host`,
`projects`, `threads`, `terminals` and `status` (spec A60); `manifest.json`
provides them since slice S62c1. The target `generate-proto` writes their protobuf-es code into
`src/contracts/gen/`, which Git ignores, and `package.json` exports it as
`./contracts/gen/*`; `@bufbuild/protobuf` is the dependency that code imports
([`project.json`](project.json), [`package.json`](package.json)).

## The process part (slices S60c, S60d)

[`src/host/process/`](src/host/process) serves the same operations as
`doric.api.*` services. [`src/host/main.ts`](src/host/main.ts) runs it with
`runBundle`, serving the eight services and the `onHostStartHook` handler;
`provides` lists the eight `api.*/v1@1.0.0` contracts since S62c1. It is the
bundle's only host entry since slice S69.

- **`createTransportHost()`**
  ([`service.ts`](src/host/process/service.ts)) builds, with no I/O, the
  `config`, `credentials`, `providers`, `host`, `projects`, `threads`,
  `terminals` and `status` services, the `hooks` table, `invalidInput` and `activate`/`deactivate`.
  Every method answers `unavailable` "transport is not active." until
  `activate` resolves, if it rejects, and after `deactivate`. `activate`
  builds the ports with `routedTransportPorts(context.services)` and runs
  `onHostStart`; its start step logs "Network interfaces configured" with
  `apiServices`, the type names of the eight `doric.api.*` services. The
  status `Watch` sends one `ready` item, then ends on the call's signal, or
  with `unavailable` on `deactivate`.
- **`projects` and `threads`.** A workspace read answers
  `{pending: {retryAfterSeconds: 1}}` or `{value}` with the route's body.
  `ReadFile` streams `pending` alone, or `head` then text chunks of at most
  1,048,576 code units that never split a code point. `ListThreads` and
  `ListEvents` end a page before 3 MiB (`API_PAGE_MAX_BYTES`). `ListThreads`
  sets the cursor only when it cuts the page; `ListEvents` reads one
  `runtime.threads/v1.ThreadEvents` page and sets `nextAfterSequence` to the
  last kept event's sequence whenever its page ends before `lastSequence`, cut
  by `transport` or by `runtime`. `GetGit` and `ListBranches` answer
  `{status, value?}`. `DeleteThread` on an agent Thread keeps `204`.
- **`Watch` streams** ([`watch.ts`](src/host/process/watch.ts)).
  `threadWatch` relays `runtime.threads/v1.WatchThread`. `projectWatch`
  merges `runtime/v2.WatchProject` and `terminal/v1.WatchProject`: it holds
  notices until both snapshots arrived, then sends `project_snapshot`,
  `terminal_snapshot` and the held notices; a source failing before both
  snapshots ends it with `replay_failed`. A second snapshot (a reopened
  source) ends either stream with `unavailable`; a source's `replay_failed`
  passes through. `statusWatch` serves the status `Watch`. All end on the
  call's signal, and with `unavailable` on `deactivate`. A `Watch` request
  that breaks protovalidate answers `invalid_input` with "Invalid project
  subscription." or "Invalid thread subscription.".
- **`routedTransportPorts(services)`**
  ([`routed.ts`](src/host/process/routed.ts)) is a full `TransportPorts` over
  routed calls, converting with `runtime/contracts` `encode`/`decode`. Each
  client is created at its first call; a failure becomes a `ContractError`, a
  missing provider `unavailable`; it sets no deadline of its own;
  `lease.ssh` goes through `runOnProjectLease`; an answer that leaves an
  always-present field unset is `invalid_output`. `TransportPorts.tools.list`
  may answer asynchronously.
- **`invalidApiInput`** ([`src/host/api/violations.ts`](src/host/api/violations.ts)),
  passed as `BundleDefinition.invalidInput`, maps protovalidate violations to
  today's refusals through `apiViolations`, keyed `/<typeName>/<Method>`
  (path rows built with `idPath`): a violation on the method's path field
  (`<kind>_id`) answers its path refusal (`invalid_<kind>_id`), any other
  answers the method's other refusal; a method without an entry keeps
  `invalid_input`. `PutConfig` keeps protovalidate's message.

`@connectrpc/connect` is a dependency of the package.

## Build and test

```console
npx nx run bundle-transport:typecheck
npx nx run bundle-transport:test
npx nx run bundle-transport:build
```

`build` and `typecheck` run `generate-proto` first, and `test` runs `build`
first. `build` compiles with `tsc --build` and runs the bundle builder, which writes
`dist/`; `test` compiles `tests/` with `tsconfig.spec.json` into `dist-tests/`
and runs `node --test` on it ([`project.json`](project.json)).
`npx nx run doric-host:build-bundles` stages every built bundle, this one
included, into `app/backend/doric-host/dist/bundles`.
