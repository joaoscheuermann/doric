# Transport bundle

`transport` is the Doric host's network API: it registers the REST routes and
the Socket.IO namespaces that clients use to create Projects and Threads, send
prompts, read workspace files and diffs, drive terminals, edit the
configuration and credentials, and follow a Thread's events live. It stores
nothing: every route and every socket answer is the answer of a contract call
to the bundle that owns the data.

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
  `description`: "The host REST routes and Socket.IO namespaces."
- `provides`: none. The bundle defines no contract, slot, tool or hook.
- `requires`: `hooks/v1@^1.0.0`, `runtime/v2@^2.0.0`,
  `runtime.threads/v1@^1.7.0`, `runtime.lease/v1@^1.0.0`, `sandbox/v1@^1.0.0`,
  `tools/v1@^1.0.0`, `models/v1@^1.0.0`, `secrets/v1@^1.0.0` and
  `host-config/v1@^1.0.0`.
- `optional`: `files/v1`, `git.commands/v1`, `usage/v1`, `resources/v1` and
  `terminal/v1`. These are the feature bundles' contracts: the transport
  activates without them, and a disabled or quarantined feature bundle does
  not take it down; the routes and the socket reads that call one fail while
  it is absent ([Absent provider](#activation-and-mounting)).

It has one part, the host part ([`src/host/`](src/host)). The shipped
[`composition.json`](../../../app/backend/doric-host/composition.json) lists it
under `resident`, so its host part runs in the kernel process, the only
process where the native network handles are reachable, and under
`required.bundles`, so the host does not start without it
([Bundles and composition](../../../app/backend/doric-host/README.md#bundles-and-composition),
[`resident`](../../../docs/architecture/bundles/composition-and-distribution.md#resident)).
A resident bundle belongs to the kernel, so publishing a new generation does
not replace it; a change to it needs a host restart.

## Contracts it uses

| Contract                                                                                                                                                                                    | What the transport calls it for                                                                                                                   |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `doric.network/v1` ([shape](../../../docs/architecture/bundles/contexts.md#shapes-of-the-platform-contracts))                                                                               | `register`: receives the kernel's Express app and Socket.IO server ([`src/host/index.ts`](src/host/index.ts))                                     |
| `hooks/v1`, `doric.app.hooks/v1` ([hooks](../../../docs/architecture/bundles/hooks.md))                                                                                                     | `onHostStartHook`: the startup log line ([`src/kernel.ts`](src/kernel.ts))                                                                        |
| `doric.startup/v1`                                                                                                                                                                          | `log`: writes the startup log line ([`src/kernel.ts`](src/kernel.ts))                                                                             |
| `host-config/v1` ([README](../host-config/README.md))                                                                                                                                       | `current`, `replace`: `/config`                                                                                                                   |
| `secrets/v1`                                                                                                                                                                                | `list`, `kinds`, `create`, `update`, `delete`: `/credentials`                                                                                     |
| `models/v1`                                                                                                                                                                                 | `kinds`, `kind`, `catalog`: `/providers`                                                                                                          |
| `tools/v1`                                                                                                                                                                                  | `list`: `/tools`                                                                                                                                  |
| `sandbox/v1` (declared by [`runtime`](../../runtime/runtime/README.md), provided by [`docker`](../../sandboxes/docker/README.md) or [`firecracker`](../../sandboxes/firecracker/README.md)) | `machines`, `machine`: `/vms`                                                                                                                     |
| `runtime/v2` ([README](../../runtime/runtime/README.md))                                                                                                                                    | Project creation, listing, rename, color, read, terminate and delete; `vmSsh`; `watch` for the workspace sockets                                  |
| `runtime.threads/v1` ([README](../../runtime/runtime/README.md))                                                                                                                            | Every Thread and queue route, Project Thread creation and lists, and the durable reads of the socket snapshots                                    |
| `runtime.lease/v1` ([README](../../runtime/runtime/README.md))                                                                                                                              | `ssh`, bound to `{ projectId }`: `GET /projects/:id/ssh`                                                                                          |
| `files/v1` ([README](../../features/files/README.md))                                                                                                                                       | `directory`, `tree`, `content`, bound to `{ projectId }`: the Project file reads                                                                  |
| `git.commands/v1` ([README](../../features/git/README.md))                                                                                                                                  | `diff`, `changes`, `fileDiff` bound to `{ projectId }`; `status`, `branches`, `switchBranch` unbound: the Project diffs and the Thread Git routes |
| `resources/v1` ([README](../../features/resources/README.md))                                                                                                                               | `host` unbound for `GET /resources`; `project` bound to `{ projectId }` for `GET /projects/:id/resources`                                         |
| `usage/v1` ([README](../../features/usage/README.md))                                                                                                                                       | `thread`: `GET /threads/:id/usage`                                                                                                                |
| `terminal/v1` ([README](../../features/terminal/README.md))                                                                                                                                 | `list`, `create`, `snapshot`, `input`, `resize`, `stop`: the terminal routes; `watchProject`: the `/projects` terminal events                     |

`secrets/v1`, `models/v1` and `tools/v1` are basic contracts of
`bundle/contracts`, provided by [`core`](../core/README.md)
([basic contracts](../../../docs/architecture/bundles/contexts.md#the-basic-contracts)).

## Activation and mounting

- **Registration.** The host part's `activate` calls
  `doric.network/v1.register` with a listener. The kernel calls it with its
  native Express app (`http`) and Socket.IO server (`sockets`), in process and
  never serialized; the listener builds the bundle with `createTransport` over
  them and activates it with the part's own services. The cleanup it returns
  runs when the registration is disposed, which the part's own cleanup does on
  deactivation ([`src/host/index.ts`](src/host/index.ts)).
- **Call-time resolution.** `createTransport` builds one `TransportServices`
  object ([`src/host/services.ts`](src/host/services.ts),
  [`src/kernel.ts`](src/kernel.ts)). Each member is a contract stub that finds
  its provider when it is called, so a request reaches the generation that is
  active when it arrives, and nothing calls a generation at activation.
  `lease`, `files`, `git` and `resources` are functions that bind the call
  scope given (`{ projectId }` or `{ threadId }`); `usage` and `terminal`
  resolve the contract on each member access. The feature contracts are read
  from `options.features()` when it is given and from the part's own services
  otherwise; the installed host part gives none.
- **Absent provider.** A call to a contract with no active provider rejects
  with the contract error `unavailable`, so its route answers
  `500 internal_error` (`PUT /config` answers `503 configuration_rejected`);
  without `terminal/v1`, the `terminal/v1.list` read of
  every `/projects` snapshot rejects, so every `/projects` subscription gets
  `workspace:error` `replay_failed` and is disconnected. While no generation
  is active, a call to a contract the latest generation provides waits for
  the next activation instead
  ([`dispatch.ts`](../../../packages/bundle/src/runtime/dispatch.ts),
  [`manager.ts`](../../../packages/bundle/src/process/manager.ts),
  [`src/host/sockets/workspace.ts`](src/host/sockets/workspace.ts)).
- **Mount order.** `registerHttpRoutes` mounts on the app, in this order
  ([`src/host/app.ts`](src/host/app.ts)): `express.json()`, the terminal router
  at the root, then `/vms`, `/config`, `/credentials`, `/resources`,
  `/providers`, `/projects`, `/threads` and `/tools`, and last the error
  handler `handleHttpError`. The vms, resources and tools routers take the
  services like the others.
- **Route bodies.** Each route body is an operation of
  [`src/host/api/operations/`](src/host/api/operations) (`config`,
  `credentials`, `providers`, `host`, `projects`, `threads`, `terminals`)
  over `TransportPorts` ([`src/host/api/ports.ts`](src/host/api/ports.ts)), the
  narrowed services. An operation returns an `ApiAnswer`, and the router only
  calls `sendAnswer(response, await operations.x(routeInput(request)))`
  ([`src/host/api/answer.ts`](src/host/api/answer.ts)): `pending` answers
  `202` with `Retry-After: 1`, an empty answer `204` with no body, a refusal
  `{ error: { code, message } }`. `apiError` turns a REST refusal into a
  `ContractError`; `apiFailure` passes `unavailable`, `generation_lost`,
  `limit_exceeded`, `deadline_exceeded` and `cancelled` through, reading a
  `ConnectError` as well as a `ContractError`, and turns any
  other failure into `internal_error`; `answerValue` unwraps an answer;
  `routeInputOf` decodes a message through `runtime/contracts` `decode`. The
  credential body schemas `CredentialCreateSchema` and
  `CredentialUpdateSchema` live in `operations/credentials.ts`.
- **Namespaces.** `registerStatusSocket` opens `/status`
  ([`src/host/sockets/status.ts`](src/host/sockets/status.ts));
  `createWorkspaceSocket` opens `/threads` and `/projects` and returns a
  `runtime/v2` listener
  ([`src/host/sockets/workspace.ts`](src/host/sockets/workspace.ts)).
- **Following providers.** `whenAvailable(RuntimeV2)` calls `watch` with that
  listener on each `runtime/v2` provider, and `whenAvailable(TerminalServiceV1)`
  attaches each `terminal/v1` provider to the terminal feed, so both follow a
  generation change; each subscription ends when its provider leaves
  ([`src/kernel.ts`](src/kernel.ts)).
- **Startup log.** An `onHostStartHook` handler logs, through
  `doric.startup/v1.log`, the message `Network interfaces configured` at level
  `info` with the field `socketNamespaces: ['/status', '/projects', '/threads']`,
  before the host binds ([`src/kernel.ts`](src/kernel.ts)).
- **Deactivation** disposes the startup hook and the two `whenAvailable`
  subscriptions. Express and Socket.IO have no unmount: the routers and
  namespaces stay on the app and the server until the kernel closes them
  ([`src/kernel.ts`](src/kernel.ts)).

The kernel owns the address, the bind, the close, and the generic desktop
namespace `/doric/bridge`
([The desktop bridge](../../../app/backend/doric-host/README.md#the-desktop-bridge));
the host app itself registers no product route.

## HTTP behavior

### Common rules

- **Authentication.** No route authenticates its caller; the host is kept on a
  trusted network
  ([Network exposure](../../../app/backend/doric-host/README.md#network-exposure),
  [`src/host/routes/credentials.ts`](src/host/routes/credentials.ts)).
- **Bodies.** `express.json()` with its defaults parses JSON bodies up to
  100 KiB. A route that reads `request.body ?? {}` treats a missing body as an
  empty object. Every body schema of the routers is strict, so an unknown
  field fails it; `PUT /config` alone hands its body unchecked to
  `host-config/v1` ([`src/host/app.ts`](src/host/app.ts),
  [`src/host/routes/config.ts`](src/host/routes/config.ts)).
- **Error envelope.** Every refusal is `{ error: { code, message } }`, written
  by `sendError` ([`src/host/errors.ts`](src/host/errors.ts)). The shared
  helpers of [`src/host/routes/input.ts`](src/host/routes/input.ts) for the
  kinds `project`, `thread` and `credential`:
  - `validateId(kind)`, mounted on `/:id` of the Projects, Threads and
    Credentials routers: a path id that is not a UUID answers
    `400 invalid_<kind>_id` with `The <kind> ID is invalid.`;
  - `missing(response, kind)`: `404 <kind>_not_found`,
    `The <kind> was not found.`;
  - `conflict(response, kind, reason)`: `409 <kind>_<reason>`, with
    `storageMessage` of `runtime/contracts` when `reason` is `storage_low` and
    `The <kind> cannot perform this operation.` otherwise;
  - `pageInput`: `limit` 1–100 (default 50) and an optional UUID `cursor`,
    coerced from the query; `nameInput`: `normalizeName`, then `isValidName`,
    both from `runtime/contracts`.
- **Terminal and VM ids** are not UUIDs, and their routers check none: an
  unknown one answers `404 terminal_missing` or `404 vm_not_found` where the
  route reads it, and `DELETE /terminals/:id` answers `204` for any id.
  `GET /projects/:id/terminals` and `POST /threads/:id/terminals` belong to
  the terminal router, which answers them before the Projects and Threads
  routers, so their ids are not checked either.
- **Caching.** The terminal router, mounted first at the root, sets
  `Cache-Control: no-store` on every request that enters it, so every route
  answers `no-store` ([`src/host/routes/terminals.ts`](src/host/routes/terminals.ts)).
  A malformed or oversized JSON body fails in `express.json()`, before the
  terminal router, so its `500` carries no `no-store`.
  The SSH, workspace, queue, usage, events, Git and resources routes also set
  it themselves.
- **Unexpected failures.** A handler that throws or rejects, a contract call
  that fails, a malformed JSON body and a body over the parser's limit all
  reach `handleHttpError`, which answers `500 internal_error` with
  `The request could not be completed.` and never the underlying message. The
  Projects, Threads and VMs routers end with the same handler, and the app
  ends with it ([`src/host/errors.ts`](src/host/errors.ts)).
- **Unknown routes** answer Express's default `404` HTML page.
- **REST error table.** The answers to the `runtime/contracts` outcomes match
  the table `restErrors` of the `runtime` bundle, which the desktop's adapters
  read; `PATCH /threads/:id` calls `restErrors.setThreadExecution` itself
  ([`src/host/routes/threads.ts`](src/host/routes/threads.ts),
  [errors of the runtime](../../runtime/runtime/README.md#errors-and-failure-behavior)).

### Routers

Each router validates its input, calls one contract method per step, and maps
the method's outcome to a status. The paths and success statuses are in the
host's [Routes](../../../app/backend/doric-host/README.md#routes) table.

- **Configuration** ([`src/host/routes/config.ts`](src/host/routes/config.ts)):
  `GET` answers `host-config/v1.current()` unchanged. `PUT` hands the body to
  `replace`: `replaced` answers `200` with the new `config`, `invalid` answers
  `422 invalid_config` with the contract's message, and any other outcome or a
  rejection answers `503 configuration_rejected`
  (`The Doric configuration could not be activated.`).
- **Credentials**
  ([`src/host/routes/credentials.ts`](src/host/routes/credentials.ts)):
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
  (`The host cannot store credential secrets.`); any other error reaches the error handler. `DELETE` answers `missing` with
  `404` and `referenced` with `409 credential_referenced`.
- **Providers** ([`src/host/routes/providers.ts`](src/host/routes/providers.ts)):
  `GET /providers/kinds` answers `{ kinds }` from `models/v1.kinds()`.
  `POST /providers/models` takes `{ kind, configuration }` (a trimmed kind of
  1–128 characters and a record of strings), looks the kind up with
  `models/v1.kind`, and accepts the configuration when every key is a declared
  field with a non-blank value of its kind (`url`: `http://` or `https://`;
  `number`: finite; `enum`: one of its options; `secret`: a credential UUID;
  `text`: any) and every required field is present; otherwise it answers
  `422 invalid_provider`. It answers `{ models }` when `models/v1.catalog`
  reads them, and `502 model_catalog_unreadable` otherwise.
- **Tools** ([`src/host/routes/tools.ts`](src/host/routes/tools.ts)): answers
  `{ tools: [{ name, description, settings }] }` from `tools/v1.list()`;
  listing runs no tool.
- **Resources** ([`src/host/routes/resources.ts`](src/host/routes/resources.ts)):
  answers `resources/v1.host()` unchanged.
- **VMs** ([`src/host/routes/vms.ts`](src/host/routes/vms.ts)): `GET /vms`
  answers `sandbox/v1.machines()`. `GET /vms/:id/ssh` reads the machine with
  `sandbox/v1.machine` (`404 vm_not_found` when absent), then
  `runtime/v2.vmSsh` (`409 vm_ssh_unavailable` when absent), and answers
  `{ vm, ...access }`. The machines are those of the active generation's
  `sandbox/v1` provider, the `docker` or `firecracker` bundle
  ([sandboxes](../../../docs/features/sandboxes.md)).
- **Projects** ([`src/host/routes/projects.ts`](src/host/routes/projects.ts)):
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
- **Threads** ([`src/host/routes/threads.ts`](src/host/routes/threads.ts)):
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
- **Terminals** ([`src/host/routes/terminals.ts`](src/host/routes/terminals.ts)):
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

- **`/status`** has no middleware and no event: a connection only confirms
  that the host is reachable
  ([`src/host/sockets/status.ts`](src/host/sockets/status.ts)).
- **Handshake.** A namespace middleware parses `socket.handshake.auth` only,
  never the query: `/threads` takes `{ threadId: UUID, afterSequence }`
  (a non-negative integer, coerced, default 0) and `/projects` takes
  `{ projectId: UUID }`. A handshake that fails is refused with
  `Invalid thread subscription.` or `Invalid project subscription.`
  ([`src/host/sockets/workspace.ts`](src/host/sockets/workspace.ts)). This
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
  leaves it closed until the next provider
  ([`src/host/sockets/terminal-feed.ts`](src/host/sockets/terminal-feed.ts)).
- **Failure.** A snapshot read that rejects sends `workspace:error` with the
  code `replay_failed` and the message `The snapshot could not be loaded.`,
  and disconnects the socket.
- **Disconnect** removes the socket and drops its buffered events and notices.

## Data and persistence

The bundle persists nothing and keeps no file. Its only state is in memory and
lives as long as the process: per socket, its readiness, its sequence cursor,
its buffered events and notices; per Project, its open terminal stream
([`src/host/sockets/workspace.ts`](src/host/sockets/workspace.ts),
[`src/host/sockets/terminal-feed.ts`](src/host/sockets/terminal-feed.ts)).

## Configuration and limits

The bundle reads no setting and no environment variable. Its limits are the
schemas above and the 100 KiB JSON body of `express.json()`. The largest
Socket.IO message is the kernel's setting
([How the host is built](../../../app/backend/doric-host/README.md#how-the-host-is-built)).

## The public API protos

[`proto/doric/api/`](proto/doric/api) holds the eight contracts of the public
API's target shape, `api.<resource>/v1` in the packages
`doric.api.<resource>.v1` for `config`, `credentials`, `providers`, `host`,
`projects`, `threads`, `terminals` and `status` (spec A60). `manifest.json`
does not provide them yet: `transport` adds them to `provides` in phase 3.
The target `generate-proto` writes their protobuf-es code into
`src/contracts/gen/`, which Git ignores, and `package.json` exports it as
`./contracts/gen/*`; `@bufbuild/protobuf` is the dependency that code imports
([`project.json`](project.json), [`package.json`](package.json)).

## The process part (slices S60c, S60d)

[`src/host/process/`](src/host/process) serves the same operations as
`doric.api.*` services. [`src/host/main.ts`](src/host/main.ts) runs it with
`runBundle`, serving the eight services and the `onHostStartHook` handler;
the kernel keeps mounting [`src/host/index.ts`](src/host/index.ts) (the
Express routes and Socket.IO) until group F, and the `api.*` contracts enter
`provides` in S62.

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
  `ListEvents` end a page before 3 MiB (`API_PAGE_MAX_BYTES`) and set the
  cursor only when they cut it. `GetGit` and `ListBranches` answer
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

## The `transport/kernel` entry

`package.json` exports `./package.json`, `./contracts/gen/*` (above) and
`./kernel` ([`src/kernel.ts`](src/kernel.ts)):

- `createTransport(options)` returns the bundle as an `EmbeddedBundle`: an
  inline manifest (id `transport`, version `0.0.0`, the description above,
  no `provides`, `requires` equal to `transportRequires`, no `optional`), an
  empty descriptor, and the host part described above. `options` holds `app`
  (an Express app), `io` (a Socket.IO server), an optional `logger` (a pino
  logger the code does not read) and an optional `features`, a function
  returning the services the feature contracts are read from.
- `transportRequires`: the nine `requires` entries of `manifest.json`.
- The types `TransportServices`, `LeaseScope` (`{ projectId }` or
  `{ threadId }`) and `ProjectScope` (`{ projectId }`).

No other package imports `transport/kernel`: the host part imports
`../kernel.js`, and the tests import `../src/kernel.js` and boot the bundle
over fake providers ([`tests/support/host.ts`](tests/support/host.ts)).

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
