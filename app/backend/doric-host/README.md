# Doric host

The Doric host is the self-hosted backend that runs your agents. It gives each
**Project** its own sandbox (files, Git, terminal, web), runs every **Thread**
of that Project as an independent conversation, persists every prompt, event
and provider history in PostgreSQL, and exposes REST and Socket.IO so the
desktop app, scripts and other clients can drive it. Read this if you deploy
the host, integrate with its API, or change the kernel.

For the product overview and the quickest way to get everything running, start
with the [main README](../../../README.md).

## Contents

- [Concepts](#concepts)
- [Run the host](#run-the-host)
- [Configuration](#configuration)
- [How the host is built](#how-the-host-is-built)
- [Project and Thread lifecycle](#project-and-thread-lifecycle)
- [REST API](#rest-api)
- [Socket.IO](#socketio)
- [Docker deployment details](#docker-deployment-details)
- [Provider upgrades](#provider-upgrades)
- [Persistence and security](#persistence-and-security)
- [Storage protection](#storage-protection)
- [Validation](#validation)

## Concepts

- A **Project** owns one environment: a sandbox lease, its durable workspace
  volume, and the configuration captured when it was created.
- A **Thread** owns an independent conversation, a FIFO prompt queue, and an
  ordered, durable event history. A Thread may have a parent, so agents can
  delegate work to child Threads you can open and inspect.
- Root and child Threads of one Project share its files and processes; they
  are not isolated from each other.
- There is no Thread count, concurrency or depth cap: different Threads can
  run at the same time.

There is no legacy Session or A2A API.

## Run the host

### With Docker Compose

[`compose.yaml`](compose.yaml) runs the host with PostgreSQL. Copy
[`.env.example`](.env.example) to `app/backend/doric-host/.env` and fill in real
values; that file is git-ignored and is the only place these secrets should
live. Build the sandbox image first (see
[The sandbox image](#the-sandbox-image)), then:

```sh
cp app/backend/doric-host/.env.example app/backend/doric-host/.env   # then edit it
docker build -f app/backend/doric-host/.sandbox.Dockerfile -t doric-sandbox:local app/backend/doric-host
cd app/backend/doric-host
docker compose --profile docker build
docker compose --profile docker up -d
```

From the repository root, `npm run doric:docker:build` runs the same `up` with
`--build` under the Compose project name `doric`.

Compose starts:

| Service       | What it does                                                                       |
| ------------- | ---------------------------------------------------------------------------------- |
| `postgres`    | PostgreSQL on a durable volume, published on `127.0.0.1:${DORIC_POSTGRES_PORT}`.   |
| `migrate`     | One-shot `prisma migrate deploy`; the host waits for it to complete.               |
| `docker`      | The host with the Docker sandbox provider (profile `docker`).                      |
| `firecracker` | The host with the Firecracker provider instead (profile `firecracker`); see below. |

The `firecracker` profile replaces the Docker provider and needs `/dev/kvm` plus
privileged mode. Confirm the deploy from the host log (`Bundles loaded` reports
the bundle, tool and skill counts) and `GET /projects`.

### Natively

Run PostgreSQL yourself (or only the Compose `postgres` service), point
`DORIC_DATABASE_URL` at it, apply the migrations, and serve the host:

```sh
export DORIC_DATABASE_URL=postgresql://USER:PASSWORD@127.0.0.1:5432/DB
npx nx run doric-host:migrate
npx nx serve doric-host
```

Startup never applies migrations. `serve` and `run` build the host and its
bundles first.

## Configuration

HTTP and Socket.IO share one listener, `0.0.0.0:3000` by default.

| Variable                      | Default                                          | Meaning                                                                                                        |
| ----------------------------- | ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------- |
| `DORIC_HOST`                  | `0.0.0.0`                                        | Address the HTTP/Socket.IO listener binds.                                                                     |
| `DORIC_PORT`                  | `3000`                                           | Port of that listener.                                                                                         |
| `DORIC_DATABASE_URL`          | —                                                | PostgreSQL connection URL. Required; a missing URL or unreachable database fails startup at `database_client`. |
| `DORIC_CREDENTIAL_KEY`        | —                                                | 32 base64-encoded bytes that encrypt stored credential secrets. Required once a credential holds a secret.     |
| `DORIC_STORAGE_PATH`          | current directory                                | Filesystem the [storage protection](#storage-protection) measures. Compose sets `/var/lib/doric/postgresql`.   |
| `DORIC_SANDBOX_PROVIDER`      | `docker`                                         | `docker` or `firecracker`, applied to the shipped composition only (not to a custom `DORIC_COMPOSITION`).      |
| `DORIC_SANDBOX_IMAGE`         | `node:22-bookworm`                               | Image every Project sandbox runs. Compose's `docker` profile defaults it to `doric-sandbox:local`.             |
| `DORIC_SANDBOX_SSH`           | off                                              | `true` adds loopback-bound user SSH access to the active sandbox. Compose profiles default it to `true`.       |
| `DORIC_SANDBOX_DOCKER_SOCKET` | off                                              | `true` mounts the host's Docker socket into every Docker sandbox. See [the sandbox image](#the-sandbox-image). |
| `DORIC_BUNDLES_PATH`          | the staged `app/backend/doric-host/dist/bundles` | Root of the installed bundles.                                                                                 |
| `DORIC_COMPOSITION`           | [`composition.json`](composition.json)           | Composition to boot. A custom one is booted as written.                                                        |
| `DORIC_LOG_FILE`              | `doric.log`                                      | File that receives the debug-level log; the console shows info and above.                                      |

Compose also reads `DORIC_POSTGRES_USER`, `DORIC_POSTGRES_PASSWORD`,
`DORIC_POSTGRES_DB` and `DORIC_POSTGRES_PORT` (default `5432`) from the
environment file to start PostgreSQL and build `DORIC_DATABASE_URL`.

## How the host is built

The host is a small kernel. Everything a user sees — Projects, Threads, tools,
providers, sandboxes, routes and the desktop UI — comes from **bundles** the
kernel loads through the `bundle` platform package.

```text
src/
├── index.ts          composition root: listener, logger, bundle boot
└── lib/
    ├── bridge/
    │   ├── catalog.ts   the bundle catalog the desktop downloads
    │   └── socket.ts    the desktop bridge namespace `/doric/bridge`
    └── bundles/
        └── boot.ts      bundle paths, composition, structural checks
```

### Bundles and composition

The host reads the installed bundles below `DORIC_BUNDLES_PATH` and the
composition at `DORIC_COMPOSITION`. The shipped
[`composition.json`](composition.json):

- names `core` as the core and lists the enabled bundles;
- chooses `postgres` for `storage.backend/v1` and `secrets.backend/v1`;
- names the `resident` bundles that run in the host process itself
  (`host-config`, `transport`, `screen-relay`) rather than in a generation
  process;
- names the `required` contracts and bundles the host refuses to serve
  without;
- offers the `sandbox` alternative (`docker` or `firecracker`) that
  `DORIC_SANDBOX_PROVIDER` selects.

What each bundle owns:

- **`postgres`** (foundation) owns the Prisma schema, the migrations and the
  process's one PostgreSQL client.
- **`core`** provides `hooks/v1`, `log/v1`, `tools/v1`, `skills/v1`,
  `settings/v1`, `secrets/v1`, `storage/v1` and `events/v1`. Every other bundle
  registers its tools with `tools/v1`, and the loader registers each bundle's
  `skills/*/SKILL.md` with `skills/v1`, in lexical folder order.
- **`direct`** (`bundles/runtime/direct`) holds the Direct executor and its
  prompt. It binds every registered tool and appends every registered skill on
  each prompt.
- **`threads`** (`bundles/features/threads`) ships the delegation tools
  `thread-spawn`, `thread-list`, `thread-get`, `thread-events`, `thread-send`,
  `thread-restart`, `thread-interrupt` and `thread-terminate`, which reach the
  host only through
  `runtime.threads/v1`.
- **`files`** and **`git`** tools reach the Thread's working directory and the
  Project sandbox through `runtime.workspace/v1` and `runtime.lease/v1`; the
  **`terminal`** tool reaches tracked terminals through `terminal/v1`.
- **`runtime`** provides those contracts by forwarding each call to the
  per-prompt `Host` facade (its types live in
  `bundles/runtime/runtime/src/contracts/tool-host`), bound to the calling
  prompt's scope only while that prompt runs. Lifecycle and authorization stay
  in `runtime`: its runner builds the prompt-scoped facade, and every tool call
  acts only on the calling prompt's direct children in the same Project.
- **`transport`** registers every REST and Socket.IO route on the kernel's
  listener through `doric.network/v1`. `app/backend/doric-host` keeps no
  product route; it owns only the generic desktop bridge `/doric/bridge`.
- **`host-config`** owns the configuration: one `settings/v1` space,
  `host-config.configuration/v1`, resident in the kernel process. It also names
  the credentials the configuration references, so deleting one is refused.

### Startup and failures

Activating the bundles opens no database. The `postgres` bundle connects its
client in its `onHostStartHook` (stage `database_client`), so a missing URL or
an unreachable database fails there. Credentials are read through `secrets/v1`,
loaded by the `core` bundle at `credential_activation`.

- A bundle that fails validation or activation is **quarantined**, logged as
  `Bundle quarantined` with its reasons, and the others keep serving. The
  desktop splash lists quarantined bundles and can disable one, which writes
  `composition.overrides.json` beside the active composition.
- A core that cannot activate, or a composition whose `required` contracts or
  bundles are not all active, puts the host in **recovery mode**. The host has
  no recovery surface of its own: it logs `Bundle recovery mode` with the
  reason and every bundle's state, and startup fails at the `bundle_load`
  stage. A required provider lost after boot takes the same fatal path, so a
  supervisor restarts the host.

## Project and Thread lifecycle

### States

- Create a Project first, then create its Threads explicitly. Project creation
  does not create a conversation.
- Projects move from `queued` to `ready` once their sandbox is acquired.
- Threads wait for the environment and then process prompts through
  `ready -> running -> ready`.
- Termination goes `cancelling -> cancelled` and stays terminal. Acquisition
  or reconciliation failures use `failed`.

### Stop, rewind, terminate, delete

- **Stop** (`POST /threads/:id/interrupt`) closes a durable per-Thread dispatch
  gate and aborts the active prompt. The prompt finishes with
  `prompt.finished` `status: cancelled` and `reason: interrupted`, keeping the
  history it wrote. Queued inputs stay accepted but wait until
  `POST /threads/:id/queue/resume` reopens the gate. Repeated stops are
  idempotent, the gate survives a host restart, and a stop never interrupts
  child Threads.
- **Rewind** replaces an edited turn. It requires an idle Thread with an empty
  queue and discards that turn and every later one.
- **Terminating a Thread** cancels its entire subtree but leaves other Threads
  and the Project environment available.
- **Terminating a Project** cancels all its Threads before releasing its lease.
- Cancellation is cooperative; it does not undo sandbox changes.
- Projects do not expire automatically. Terminate unused Projects to release
  their environments.
- **Physical deletion** requires terminal state, including descendants, and
  discards the Project's durable workspace volume.

### Host restarts

A Project survives a host restart. A host stop is not a termination:

1. The stop releases the lease, writes the Project back as `queued` (it needs a
   sandbox again) and its non-terminal Threads as `ready`, and _pauses_ the
   running prompt. The prompt stays unfinished, with
   `prompt.paused { reason: 'host_stopped' }`, so the next boot takes it up
   again.
2. The next boot reconciles instead of failing: a non-terminal Project becomes
   `queued`, a non-terminal Thread becomes `ready`, and a prompt whose run
   started but never recorded a pause gets
   `prompt.paused { reason: 'host_restarted' }`, because the restart is what
   interrupted it. A record a crash left `cancelling` becomes `cancelled`
   instead: reviving it would resurrect work the reader stopped.
3. That boot also takes up the work itself. For every Project holding a prompt
   the host interrupted — one whose pause it recorded, one whose restart only
   the boot discovered, or one that never started at all — it acquires the
   Project's own sandbox and re-enqueues those prompts in the order the log
   accepted them, each opening its next attempt with
   `prompt.resumed { attempt }`.

The queue is restored before HTTP starts listening, while sandbox acquisition
continues in the background so full capacity cannot block boot. Only such a
Project pays for a sandbox before anyone asks for one; a Project with nothing
pending stays `queued` and acquires nothing.

A prompt the host has already taken up twice is closed as a failure instead,
with `resume_exhausted` and a message telling the reader to send the prompt
again, so a host that keeps dying on one prompt stops circling it. An
interrupted prompt resumes from the provider history persisted as its run
advanced — the assistant turns and tool results it already had; a history that
ends in a tool call the restart interrupted is answered before it continues,
and the reader's own input is never repeated. The reader can take up an
unfinished prompt through `POST /threads/:id/resume`, which no budget bounds.

### On-demand sandboxes

Acquisition is on demand:

- Sending a prompt to a Project that has no runtime reacquires its sandbox
  first — with the Project's own identity, so it returns to the same files —
  sets the Project and its Threads `ready`, and then runs the prompt, keeping
  arrival order when several prompts race to bring it back.
- A read that needs a lease keeps answering `pending`/`unavailable` and never
  resumes a Project by itself, which is what makes the boot resume the one
  exception.
- Terminating a Thread needs no runtime: a Thread of a resumed Project still
  takes itself and its subtree through `cancelling -> cancelled` durably, so it
  can be deleted without prompting first.
- Every reacquired sandbox is validated against each Thread's working directory
  in one probe, and a directory it no longer holds is reset to the workspace
  root (see [the Thread working directory](#the-thread-working-directory)).

## REST API

### Routes

Configuration, credentials and providers:

| Method    | Path                | Success   | Purpose                                                    |
| --------- | ------------------- | --------- | ---------------------------------------------------------- |
| GET / PUT | `/config`           | 200       | Read / replace configuration.                              |
| GET       | `/credentials`      | 200       | List named credentials without their secrets.              |
| POST      | `/credentials`      | 201       | Create a named credential.                                 |
| PATCH     | `/credentials/:id`  | 200       | Rename, re-identify, or re-secret a credential.            |
| DELETE    | `/credentials/:id`  | 204 / 409 | Delete an unreferenced credential / refuse one in use.     |
| GET       | `/providers/kinds`  | 200       | List the provider kinds this host can configure.           |
| POST      | `/providers/models` | 200       | Read the model catalog a draft provider's endpoint serves. |
| GET       | `/tools`            | 200       | List the loaded tools and the settings each declares.      |
| GET       | `/resources`        | 200       | Read the resources of the machine the host runs on.        |

Projects and their workspace:

| Method | Path                          | Success   | Purpose                                            |
| ------ | ----------------------------- | --------- | -------------------------------------------------- |
| POST   | `/projects`                   | 202       | Reserve an environment without a Thread or prompt. |
| GET    | `/projects`                   | 200       | List Projects.                                     |
| GET    | `/projects/:id`               | 200       | Read public Project metadata.                      |
| PATCH  | `/projects/:id`               | 200       | Rename a Project.                                  |
| PATCH  | `/projects/:id/color`         | 200       | Set a palette color, or `null`.                    |
| POST   | `/projects/:id/threads`       | 201       | Create a root or child Thread.                     |
| GET    | `/projects/:id/threads`       | 200       | List Threads; optional `parentThreadId` filter.    |
| GET    | `/projects/:id/ssh`           | 200 / 202 | Read private SSH access / wait for environment.    |
| GET    | `/projects/:id/files`         | 200 / 202 | List one workspace directory.                      |
| GET    | `/projects/:id/tree`          | 200 / 202 | List a workspace directory as a tree.              |
| GET    | `/projects/:id/files/content` | 200 / 202 | Read one workspace file as bounded text.           |
| GET    | `/projects/:id/diff`          | 200 / 202 | Read the workspace Git diff and change list.       |
| GET    | `/projects/:id/changes`       | 200 / 202 | Read the changed paths with added/removed counts.  |
| GET    | `/projects/:id/files/diff`    | 200 / 202 | Compare one changed file (`repository`, `path`).   |
| GET    | `/projects/:id/resources`     | 200 / 202 | Read the Project sandbox's resources.              |
| GET    | `/projects/:id/terminals`     | 200       | List the Project's terminals.                      |
| POST   | `/projects/:id/terminate`     | 200       | Terminate the Project and its Threads.             |
| DELETE | `/projects/:id`               | 204       | Delete a terminal Project.                         |

Threads:

| Method      | Path                           | Success | Purpose                                                |
| ----------- | ------------------------------ | ------- | ------------------------------------------------------ |
| GET         | `/threads/:id`                 | 200     | Read public Thread metadata.                           |
| PATCH       | `/threads/:id`                 | 200     | Rename a Thread or move its working directory.         |
| GET         | `/threads/:id/git`             | 200     | Read the Git summary of the Thread's directory.        |
| GET / POST  | `/threads/:id/branches`        | 200     | List local branches / switch to one (`branch`, `cwd`). |
| POST        | `/threads/:id/prompt`          | 202     | Enqueue human input; returns `promptId`.               |
| POST        | `/threads/:id/steer`           | 202     | Steer the running prompt, or queue when it ended.      |
| POST        | `/threads/:id/resume`          | 202     | Take up a prompt no run has finished; returns Thread.  |
| POST        | `/threads/:id/rewind`          | 202     | Replace an earlier prompt and discard later turns.     |
| POST        | `/threads/:id/compact`         | 200     | Compact the idle Thread's context on demand.           |
| GET         | `/threads/:id/events`          | 200     | Replay durable events.                                 |
| GET         | `/threads/:id/usage`           | 200     | Read the Thread's usage.                               |
| GET         | `/threads/:id/queue`           | 200     | Read the revisioned queue snapshot.                    |
| POST        | `/threads/:id/queue/resume`    | 200     | Reopen a stopped queue; returns Thread.                |
| GET / PATCH | `/threads/:id/queue/:promptId` | 200     | Read / edit a queued prompt that has not started.      |
| DELETE      | `/threads/:id/queue/:promptId` | 204     | Remove a pending input.                                |
| POST        | `/threads/:id/interrupt`       | 200     | Stop the Thread's active prompt.                       |
| POST        | `/threads/:id/terminals`       | 201     | Open a terminal in the Thread's sandbox.               |
| POST        | `/threads/:id/terminate`       | 200     | Terminate a Thread subtree.                            |
| DELETE      | `/threads/:id`                 | 204     | Delete a terminal subtree.                             |

Terminals and VMs:

| Method | Path                    | Success | Purpose                                          |
| ------ | ----------------------- | ------- | ------------------------------------------------ |
| GET    | `/terminals/:id`        | 200     | Read a terminal snapshot after an output cursor. |
| POST   | `/terminals/:id/input`  | 204     | Write input (`data`, up to 65536 characters).    |
| POST   | `/terminals/:id/resize` | 204     | Resize (`cols`, `rows`, 1–1000).                 |
| DELETE | `/terminals/:id`        | 204     | Stop a terminal.                                 |
| GET    | `/vms`                  | 200     | List provisioned VM runtimes.                    |
| GET    | `/vms/:id/ssh`          | 200     | Read the SSH access of one VM.                   |

Terminal routes answer `Cache-Control: no-store`; terminal data is never stored
in conversation events.

### Conventions

- Lists use `{ items, nextCursor? }`, with `limit` (1–100, default 50) and an
  exclusive UUID `cursor`. Page size does not limit total Projects or Threads.
- Public metadata omits message history, prompts, credentials, and SSH keys.
- Errors use `{ error: { code, message } }`. Invalid IDs and cursors return
  400, invalid bodies 422, missing resources 404, and lifecycle conflicts 409.
- Names are trimmed, reject NUL, and contain 1–80 Unicode characters.

### Configuration and providers

`GET /config` answers `{ configuration, revision, updatedAt }`.

- The stored configuration holds no secret: a provider names the `API_TOKEN`
  credential it authenticates with, and `gitCredentialId` /
  `githubCredentialId` name the `GIT` identity and the `API_TOKEN` GitHub
  uses.
- `PUT /config` replaces the whole configuration and accepts that same shape,
  so what it answers is what it accepts. Unknown keys stay rejected
  (`422 invalid_config`), and a reference that names an unstored credential or
  the wrong kind is rejected with the same code. A replacement that cannot be
  activated answers `503 configuration_rejected`.
- Configuration saved here reaches the next prompt of any Project, including
  one that is already running.

A provider kind whose catalog describes its models declares a models URL, and
that catalog is read twice:

1. When a provider page asks what its endpoint serves: `POST /providers/models`
   takes the draft's `kind` and `configuration` values and answers `{ models }`,
   every model with its name, its reasoning efforts, the effort it names as
   that model's default, whether it pins reasoning on, and the request
   parameters it advertises. Invalid values answer `422 invalid_provider`; an
   unreadable catalog answers `502 model_catalog_unreadable`.
2. On `PUT /config`: each listed model takes the reasoning that catalog
   describes, a model the catalog does not name takes none, and the execution
   effort resolves to the one its model starts at or is dropped when that
   model lists none. A catalog that cannot be read leaves that provider as it
   was, so an unreachable endpoint never costs the configuration its model
   list.

### Credentials

`/credentials` owns the credential store.

- `GET /credentials` answers
  `[{ id, kind, name, username?, email?, hasSecret }]` and never a secret.
- `POST` takes a `name` and a `kind` of `API_TOKEN` (`secret`),
  `USERNAME_PASSWORD` (`username` and `secret`), or `GIT` (`username` and
  `email`), and rejects a field the kind does not carry.
- `PATCH` follows one rule per field: absent or `null` keeps it, `''` clears
  it, and a value sets it. `kind` is immutable
  (`409 credential_kind_immutable`), and a name already used by the kind is
  `409`.
- `DELETE` of a credential a provider or the configuration references is
  `409 credential_referenced`.
- Secrets are stored as AES-256-GCM envelopes under `DORIC_CREDENTIAL_KEY`;
  the host refuses to start when a stored secret exists and that key is
  missing or unusable.

### Create and converse

```sh
curl -X POST -H 'content-type: application/json' \
  -d '{"name":"Repository work"}' \
  http://127.0.0.1:3000/projects
# Use the returned Project id:
curl -X POST -H 'content-type: application/json' \
  -d '{"name":"Inspect tests"}' \
  http://127.0.0.1:3000/projects/PROJECT_ID/threads
# For a child, also supply "parentThreadId":"PARENT_THREAD_ID".
curl -X PATCH -H 'content-type: application/json' \
  -d '{"name":"Renamed project"}' \
  http://127.0.0.1:3000/projects/PROJECT_ID
curl -X PATCH -H 'content-type: application/json' \
  -d '{"name":"Renamed thread"}' \
  http://127.0.0.1:3000/threads/THREAD_ID
curl -X POST -H 'content-type: application/json' \
  -d '{"prompt":"Inspect the repository and run focused tests."}' \
  http://127.0.0.1:3000/threads/THREAD_ID/prompt
curl -X POST -H 'content-type: application/json' \
  -d '{"promptId":"PROMPT_ID","prompt":"Inspect only the host tests."}' \
  http://127.0.0.1:3000/threads/THREAD_ID/rewind
curl -X POST -H 'content-type: application/json' \
  -d '{"promptId":"PROMPT_ID"}' \
  http://127.0.0.1:3000/threads/THREAD_ID/interrupt
curl -X POST -H 'content-type: application/json' \
  -d '{"promptId":"PROMPT_ID"}' \
  http://127.0.0.1:3000/threads/THREAD_ID/resume
curl -X POST http://127.0.0.1:3000/projects/PROJECT_ID/terminate
```

### Request rules

- **Project creation** requires `{ "name": "..." }` and answers `202` with the
  Project, which the host marks with a random color from its palette, plus an
  `ssh.href` pointing at `/projects/:id/ssh`.
- **Thread creation** requires `{ "name": "..." }` and accepts an optional
  `parentThreadId`, which starts the child in its parent's working directory.
- **Project PATCH** requires the name-only body; **Thread PATCH** takes
  `name`, `cwd`, or both.
- **Prompt** accepts only a non-empty `prompt`. Public callers cannot forge
  parent/result origins or correlation.
- **Rewind** accepts only `{ "promptId", "prompt" }` and answers
  `202 { promptId }` like a prompt. It removes the named turn and every later
  turn from the durable event log and the provider-ready history, then accepts
  the edited text as a new human input. Each turn records the provider-history
  length it started from, so rewind truncates exactly at that turn boundary. A
  Thread that is running or has queued input refuses with `409 thread_busy`, so
  queued work never runs on truncated history; a `promptId` without a recorded
  turn in that Thread returns `404 prompt_not_found`. Sequence numbers are
  never reused.
- **Interrupt** requires `{ "promptId" }` and answers
  `200 { status: 'interrupted' }`; the stop applies to whatever prompt the
  Thread is running. A Thread that is closing, terminal, or has no runtime is
  `409 thread_inactive`.
- **Resume** accepts only `{ "promptId" }` and answers `202` with the Thread.
  It re-enqueues that one prompt — bringing the Project's sandbox back when
  the host holds none — and appends the next `prompt.resumed` attempt. A
  prompt the Thread has not left unfinished is `404 prompt_not_found`, one it
  already holds running or queued is `409 thread_busy`, a Project that cannot
  run is `409 thread_inactive`, and low storage is `409 thread_storage_low`.
- **Compact** answers `{ status, condensedMessages, retainedMessages,
tokensFreed }`. A running or queued Thread is `409 thread_busy`, a refusal
  (disabled, no history, nothing to condense) is `409 compaction_refused`, and
  a failed attempt is `502 compaction_failed`.
- **SSH**: `GET /projects/:id/ssh` returns `202` with `Retry-After: 1` while
  pending, `409` when unavailable, and `410` when expired. SSH responses forbid
  caches.

### Workspace reads

`GET /projects/:id/files`, `/tree`, `/files/content`, `/diff`, `/changes`,
`/files/diff` and `/resources` share the lease answers: `202` with
`Retry-After: 1` while the environment is pending, `409` when unavailable, and
`410` when expired.

- A workspace-relative `path` is normalised, resolved against the workspace
  root, and rejected with `422` when it escapes; a missing path is `404`.
- Content is capped at 256 KiB (`CONTENT_LIMIT_BYTES`) and reported with
  `truncated` and `binary` flags, so a binary file is never rendered as
  mangled text.
- `/diff` answers one entry per repository with its `diff` and `changes`. A Git
  diff never contains untracked files, so the `changes` list supplies them
  alongside `diff`.
- A `path` on `/diff` also scopes discovery: the repositories it reads are the
  ones that path belongs to or holds, which is how one Thread reads the
  changes of its own working directory.

### The Thread working directory

Every Thread owns a working directory inside its Project's shared sandbox. It
starts at `/workspace`, and the agent moves it with its `cwd` tool, which calls
the same rule the HTTP route does.

- `PATCH /threads/:id` takes an optional `cwd`: an absolute sandbox path, or
  one relative to the Thread's current directory the way `cd` reads it.
- A move that would leave the workspace root answers
  `400 { code: 'invalid_cwd' }`, and so does one that names no directory or
  names a file; a valid move answers the updated Thread.
- The Thread record carries the directory as `cwd` plus a cheap hint as
  `cwdRepo`: absent unless the directory's own root holds a `.git` marker, then
  `github` when that repository's `origin` points at github.com and `git`
  otherwise.
- The hint is an observation, refreshed whenever the directory moves, when one
  of the Thread's prompts settles, and when the Git summary below is read —
  and `thread:updated` is published only when it really changed.

When a Project reacquires a sandbox, every Thread whose directory is not the
workspace root is checked in one probe: a directory the sandbox no longer holds
— missing, no longer a directory, or resolving outside the root — is reset to
`/workspace` with its hint cleared, and one `thread:updated` is published for
each reset. Only an explicit negative answer resets a directory: a probe that
cannot run keeps every stored directory, because a command that failed is not
evidence that the directories are gone.

`GET /threads/:id/git` answers the Git summary of the Thread's working
directory:

- `{ repo: false }` when the directory holds, or lies in, no repository;
- otherwise its `root`, `head` (the branch, or the short commit when HEAD is
  detached), `detached`, `unborn`, `upstream`, `ahead`, `behind`, `dirty`
  (`staged`/`modified`/`untracked`), `conflicted`, `operation`
  (`merge`/`rebase`/`cherry-pick`/`revert`/`bisect`), `worktree`, `shallow`,
  and `stash` count.

One sandbox command per probe reads all of it — a
`git status --porcelain=v2 --branch` document whose headers already carry the
branch, its upstream, and the ahead/behind counts, plus the labeled facts a
small shell script prints around it — and the answer is cached per Thread until
the directory moves, a prompt settles, or the renderer asks for it. While the
Project's sandbox is not readable, the route (like `/branches`) still answers
`200` with `{ status: 'pending' }` or `{ status: 'unavailable' }`, so clients
can poll without treating it as an error; an unknown Thread is `404`.

### The prompt queue

- `GET /threads/:id/queue` returns a non-cached, revisioned snapshot with
  `paused`, `stopping`, the current active or resumable prompt, and the FIFO
  pending items, each with its prompt ID, source, display label, bounded
  preview and acceptance time.
- `POST /threads/:id/queue/resume` reopens a stopped queue: it resumes the
  latest eligible reader-paused prompt first and then the FIFO.
- `GET /threads/:id/queue/:promptId` returns the full text, edit eligibility
  and revision. `PATCH` on it requires `{ text, revision }`: only a user input
  that has never started can be edited, and a stale revision is `409`.
- `DELETE /threads/:id/queue/:promptId` removes a pending input and records
  `prompt.finished` with `status: cancelled` and `reason: queue_removed`; it
  refuses an input already executing.

### Replay

`GET /threads/:id/events?afterSequence=N` returns `{ events, lastSequence }`.
The optional cursor is exclusive (default 0). Sequence numbers are contiguous
per Thread, not globally ordered across Threads. Each event contains:

```text
{ projectId, threadId, promptId, sequence, type, event, createdAt }
```

Events are persisted before publication. Their bodies include model reasoning,
provider replay, tool inputs/results, usage, and failures. Credentials are
redacted before persistence, and the characters PostgreSQL refuses — U+0000 and
an unpaired surrogate, which binary tool output can carry — become U+FFFD, so a
single binary match cannot fail a Thread. Full prompt/event payloads are not
operational logs.

Rewind appends one `history.truncated` event whose body is
`{ type: 'history.truncated', afterSequence }`; `afterSequence` is the sequence
of the last surviving event, or `0` when none survives. Subscribers receive it
before the replacement `prompt.accepted`. Because sequence numbers are never
reused, later events continue above the marker and a replay cursor above it
simply skips the discarded range; clients drop their local events above
`afterSequence`.

### Command-line client

```sh
npm run doric:spawn-agent -- --url http://127.0.0.1:3000 \
  --prompt "Inspect the workspace" --terminate
```

The client creates a Project, then a Thread, submits the input, polls durable
replay, and prints only IDs, event metadata, and the Project SSH URL.
`--url` defaults to `DORIC_URL` or `http://127.0.0.1:3000`. Without
`--terminate`, the Project remains reserved; with it, the entire Project closes
after the submitted prompt ends, including any still-running descendants.
Configure `/config` and server credentials separately; the client does not
send credentials or A2A configuration.

## Socket.IO

```ts
import { Manager } from 'socket.io-client';

const manager = new Manager('http://127.0.0.1:3000');
const status = manager.socket('/status');
const project = manager.socket('/projects', { auth: { projectId } });

// Every watched Thread owns a Manager of its own, so that closing that
// connection is what ends the subscription the host holds for the Thread.
const thread = new Manager('http://127.0.0.1:3000').socket('/threads', {
  auth: { threadId, afterSequence: 42 },
});
```

| Namespace               | Event               | Payload                                                |
| ----------------------- | ------------------- | ------------------------------------------------------ |
| `/status`               | `connect`           | None; confirms that the Doric host is reachable.       |
| `/threads`              | `thread:snapshot`   | `{ threadId, projectId, project, thread, events }`     |
| `/threads`              | `agent:event`       | Complete persisted Thread event envelope.              |
| `/threads`, `/projects` | `thread:updated`    | Public Thread metadata.                                |
| `/threads`, `/projects` | `thread:deleted`    | `{ projectId, threadId }`                              |
| `/projects`             | `project:snapshot`  | `{ projectId, project, threads, terminals }`           |
| `/projects`             | `project:updated`   | Public Project metadata.                               |
| `/projects`             | `project:deleted`   | `{ projectId }`                                        |
| `/projects`             | `terminal:snapshot` | `{ projectId, terminals }`                             |
| `/projects`             | `terminal:updated`  | One terminal session.                                  |
| `/projects`             | `terminal:output`   | Live terminal output.                                  |
| `/projects`             | `terminal:removed`  | `{ projectId, threadId, terminalId }`                  |
| `/threads`, `/projects` | `workspace:error`   | Sanitized `{ code, message }`; connection then closes. |

The desktop app reaches the host through a separate generic namespace,
`/doric/bridge`, owned by the kernel.

### Subscriptions

- `/status` requires no parameters and emits no application payload.
- `/threads` requires `auth: { threadId, afterSequence? }` and `/projects`
  requires `auth: { projectId }`; an invalid handshake is refused.
- Reuse one `Manager` for `/status` and the Project subscription so they share
  one Engine.IO connection, and give each watched Thread a `Manager` of its
  own: closing that connection is what ends the Thread's subscription.
- Missing snapshot resources are `null`. The Project snapshot contains the full
  Thread tree as a flat array with `parentThreadId` links. Project
  reconnection resnapshots that tree; execution history is replayed separately
  per Thread.
- Thread subscriptions are installed before durable replay, buffer live events
  and lifecycle notifications, and deduplicate by sequence. Clients reconnect
  with their last received sequence.
- Terminal output is not buffered during a snapshot; a reconnect reads the
  bounded terminal snapshot instead.

### Prompt events

- Each accepted input emits `prompt.accepted` with `{ type, text, source }`;
  `text` is the input after configured-credential redaction and `source` is
  its trusted origin.
- The host emits `prompt.finished` with `{ type, status, text, source }`;
  `status` is `completed`, `failed`, or `cancelled`. Success is acknowledged
  only after conversation history is saved. Use this event, not the inner
  `agent.finished`. A persistence failure can instead make the Thread terminal
  with `persistence_failed`; clients must also observe Thread state.
- An interruption that leaves a prompt unfinished emits `prompt.paused` with
  `{ type, reason }`, where `reason` is `host_stopped` when the host stopped,
  `host_restarted` when a boot discovered the restart a run never recorded,
  and `reader_stopped` only in logs written before the reader's stop ended the
  turn.
- The reader's stop (`POST /threads/:id/interrupt`) finishes the prompt with
  `prompt.finished` `status: cancelled` and `reason: interrupted`, keeping its
  history. A prompt that never started is left without one: it was never
  running.
- The host takes its own interruptions up again by appending
  `prompt.resumed` with `{ type, attempt }`, counting from `1`, and a reader's
  own resume of the same prompt does the same under the prompt's own
  `promptId`. A resumable prompt is unfinished: a client that sees one — no
  `prompt.finished`, and a pause or a `prompt.resumed` as its last word — can
  offer the reader `POST /threads/:id/resume`.

### Steering and delivered results

`POST /threads/:id/steer` takes `{ prompt, promptId, interrupt? }`, where
`promptId` is the prompt the reader saw running, and answers
`{ status, promptId }`:

- `steered` means the running prompt takes the input in at its next safe point
  — after the tool batch in flight, or before its final answer — and
  `interrupt: true` also aborts its current step so it continues with the
  steer at once.
- `queued` means the prompt was no longer running, or the Thread was stopping,
  so the input was queued as an ordinary prompt.

The steer is accepted as `prompt.accepted` with `steer` naming the running
prompt; taking it in appends `prompt.steered` under the steer's own id, and a
steer the run ended without reading returns to the front of the queue with
`prompt.queued` `first: true`.

Delegated results and background terminal results are delivered automatically.
A Thread that is running takes them in as steers of its active prompt at the
next safe point, without interrupting it; otherwise they are queued. They can
trigger additional model/tool activity.

## Docker deployment details

### The sandbox image

The Docker profile runs sandboxes from the image built from
[`.sandbox.Dockerfile`](.sandbox.Dockerfile). On top of the base image's Git it
adds:

- the GitHub CLI;
- Docker's engine and CLI;
- the runtime libraries Electron needs, with Xvfb for headless runs, and the
  xpra screen server with its HTML5 client;
- esbuild under `/opt/doric/bundler`, so component previews bundle inside the
  sandbox (on the plain image they bundle on the host, reading each file
  through it).

Compose selects it through `DORIC_SANDBOX_IMAGE` (`doric-sandbox:local` by
default); without that variable the host provisions the plain
`node:22-bookworm` image. Build the tag before `up`:

```sh
# from the repository root, before `docker compose --profile docker up`
docker build -f app/backend/doric-host/.sandbox.Dockerfile -t doric-sandbox:local app/backend/doric-host
```

Build it first: the provider pulls an image only when it is absent locally, so
a tag that was never built fails the pool's image pull instead of silently
falling back to the plain Node image. The `firecracker` profile resolves an
anonymous **public** OCI image rather than a local tag, so it can only use this
image once the tag is published or `DORIC_SANDBOX_IMAGE` is pointed at a public
image.

The sandbox's Docker CLI reaches a daemon only where the sandbox is given
`/var/run/docker.sock` or the privileges `dockerd` needs, as Compose does for
the host itself. Set `DORIC_SANDBOX_DOCKER_SOCKET=true` in the environment file
to mount that socket into every Project sandbox. Compose leaves it off unless
the environment file sets it, because a sandbox holding the socket can drive
the host's Docker daemon; `.env.example` turns it on for local development.
Keep it off where Projects are not yours.

### Build traps

Two traps break the image build or the deployed catalog:

- Every bundle must also appear in `app/backend/doric-host/.Dockerfile`: its
  `tsc --build` list, the bundle `build` loop and the `stage` list. The host
  loads whatever the image stages in `app/backend/doric-host/dist/bundles`, so
  a bundle missing there is absent at runtime (and its composition entry is
  reported missing).
- `package-lock.json` must be generated with the npm major the build image runs
  (`node:22-bookworm-slim` ships npm 10). A lock rewritten by a newer local npm
  fails `npm ci` with `Missing: <package> from lock file`; regenerate it with
  `npx npm@10 install --package-lock-only`.

### Rotating the PostgreSQL password

To replace the PostgreSQL password of an existing deployment without losing
data, alter the role through the container's trusted local socket instead of
recreating the volume. The Compose project is named `doric-sandbox` (or `doric`
when started with `npm run doric:docker:build`), and the role is your
`DORIC_POSTGRES_USER`:

```sh
docker exec -it doric-sandbox-postgres-1 \
  psql -U doric -h 127.0.0.1 -d doric -c "ALTER ROLE doric WITH PASSWORD 'NEW'"
```

## Provider upgrades

The catalog advertises **OpenAI** (Responses-compatible endpoints) and
**OpenRouter** (the former Unified implementation). Codex remains internal and
is not advertised. LM Studio integrations and the raw OpenRouter adapter have
been removed.

- The consolidation migration maps `unified` to `openrouter` and
  `openai-compatible` to `openai`, preserving provider ids, credential
  references, models and execution selections.
- Compatible providers pointing at the standard OpenRouter URL, including the
  bootstrap row, become `openrouter`.
- Historical Project snapshots and events are preserved; usage reads still
  recognize old `unified` events.

Before upgrading a database with `lmstudio` or `lmstudio-openai` providers, use
the previous app version to configure a supported replacement, select it for
execution, and remove the old entries. The migration refuses those removed
protocols instead of silently changing endpoints or deleting configuration.

## Persistence and security

### Database

PostgreSQL holds everything durable: Projects, Threads, provider histories and
Thread event streams (kept in the generic `storage_*` tables of
`storage.backend/v1`), the configuration's `settings/v1` document, and the
credential table.

- The schema and migrations live in the `postgres` bundle
  (`bundles/foundation/postgres/prisma`);
  `app/backend/doric-host/prisma.config.ts` points at them.
- Apply migrations separately with `npx nx run doric-host:migrate` (Compose
  runs its `migrate` service); startup does not apply them.
- The history starts with the clean Project/Thread baseline, bootstrap
  configuration, singleton constraint, and immutable-tree trigger. Later
  migrations add, among others, Project and Thread names, per-turn provider-history
  checkpoints that rewind truncates, Project colors, the credential store,
  provider kinds and models, Thread working directories, usage and queue
  pauses, the provider consolidation, generic storage, runtime documents and
  registered credential kinds. They do not convert Session data.
- The generic-storage migration converts the configuration tables into the
  `host-config.configuration/v1` settings document, keeping its revision and
  update time, verifies the conversion, and then drops those tables. It
  cannot be reversed, so **back up the database first**.

Start from an empty database. A database with an older (pre-baseline) schema
or migration history must be explicitly recreated by its operator before
deployment. Neither the host nor the baseline deletes or resets an existing
database automatically.

### Network exposure

The API is unauthenticated. Keep it on an isolated trusted network, especially
because SSH responses and execution replay contain sensitive material. Provider
credential values belong in the credential store, never configuration JSON or
client requests.

### Credentials

The host owns one credential store for every secret it holds. Each credential
is named and has a kind that fixes its fields:

| Kind                | Fields                          | Use                                                |
| ------------------- | ------------------------------- | -------------------------------------------------- |
| `API_TOKEN`         | `secret`                        | Authentication: a provider key, the GitHub token.  |
| `USERNAME_PASSWORD` | `username`, `secret`            | Authentication with a name.                        |
| `GIT`               | `username`, `email` (no secret) | The identity the agent's git commands commit with. |

A secret is stored as an AES-256-GCM envelope under `DORIC_CREDENTIAL_KEY` and
is never answered over the API; the host redacts every stored secret from
events and logs before persistence and keeps it out of tool payloads. The
credential store was created by migration from the former provider environment
names and the former GitHub columns, so every provider keeps its row with a
credential whose secret is empty until its operator fills it, and the former
plaintext GitHub token is re-entered once.

### Git and GitHub inside the sandbox

The host applies the Git identity and the GitHub token to a Project's sandbox:

- `git config --global` for the identity;
- when a token is configured, `credential.helper store` plus a
  `~/.git-credentials` written 0600, and a `~/.config/gh/hosts.yml` written
  0600 so the token authenticates the sandbox's `gh`.

That happens when a lease is acquired and again whenever the current pair
differs from the one the sandbox holds, because the chosen credentials follow
the current configuration while every other value stays captured per Project.
The token travels only through the sandbox process environment, so it never
appears in a tool argument, a tool result, an event, or a log line; a write
that fails is a warning naming the Project and nothing else.

## Storage protection

The host checks available filesystem blocks at `DORIC_STORAGE_PATH` before
dispatch and every three seconds during execution.

- At **10% free or less**, or when the configured path cannot be measured,
  execution pauses and the queue shows an error.
- Free space above 10%, then resume the queue
  (`POST /threads/:id/queue/resume`); recovery never starts automatically.
- PostgreSQL disk-full errors are handled as the same pause, independently of
  the probe.

Compose sets `DORIC_STORAGE_PATH=/var/lib/doric/postgresql` and mounts its
PostgreSQL volume there read-only. Native runs default to the current
directory; set this variable to a path on the actual database filesystem. A
local path does not measure a remote PostgreSQL server: remote deployments
require a mount on that filesystem for proactive protection.

If the disk is already completely full, the host retains any unsaved history
and event in memory and refuses to resume until it can save them. Keep that
host process alive while freeing space; a process crash cannot preserve unsaved
data.

## Validation

| Command                                          | What it covers                    |
| ------------------------------------------------ | --------------------------------- |
| `npx nx run doric-host:test`                     | The host suite.                   |
| `npx nx run doric-host-e2e:e2e`                  | The full host workflow.           |
| `npx nx run agent:test`                          | The reusable agent loop.          |
| `node --test scripts/tests/spawn-agent.test.mjs` | The command-line client workflow. |

The host targets build the bundled tools first.

To include persistence tests, supply `DORIC_TEST_DATABASE_URL` pointing to a
dedicated PostgreSQL test instance. The e2e target also requires
`DORIC_TEST_SANDBOX=true`; it creates a disposable database and Docker sandbox,
and scripts only the external LLM. Without these variables, persistence cases
in `doric-host:test` skip and `doric-host-e2e:e2e` fails before running.
