# Doric Direct agent

Doric exposes sandbox-backed **Projects** and persistent **Threads**. A Project
owns one environment, sandbox lease, and captured configuration. Each Thread
owns an independent conversation, FIFO prompt queue, and ordered event history.
Root and child Threads share Project files and processes; they are not isolated.

HTTP and Socket.IO share `0.0.0.0:3000` by default (`DORIC_HOST`, `DORIC_PORT`).
There is no legacy Session or A2A API.

## Source organization

```text
src/lib/
├── agents/direct/
│   ├── executor.ts
│   └── prompts/system.ts
├── config/
│   ├── schema.ts
│   ├── service.ts
│   ├── store.ts
│   └── generation.ts
├── credentials/
│   ├── kind.ts
│   ├── resolve.ts
│   ├── secret.ts
│   ├── service.ts
│   └── store.ts
├── workspace/
│   ├── types.ts
│   ├── service.ts
│   ├── runtime.ts
│   ├── runner.ts
│   ├── prompts.ts
│   ├── projects.ts
│   ├── threads.ts
│   └── storage.ts
├── http/
│   ├── app.ts
│   └── errors.ts
├── events/
│   ├── socket.ts
│   └── serialization.ts
├── database.ts
└── vms.ts
```

The Direct system prompt is one exported literal template string; the executor
appends bundle skills in their declared order. The thread delegation tools
(`thread-spawn`, `thread-list`, `thread-get`, `thread-events`, `thread-send`,
`thread-interrupt`, `thread-terminate`) ship in the `/bundles/threads` bundle and
reach the host only through the per-prompt `Host` facade's `threads` namespace,
whose contract lives in `packages/host`. Shared lifecycle and authorization
remain in `workspace`: `runner.ts` builds the prompt-scoped facade, and every
tool call acts only on the calling prompt's direct children in the same Project.
Sandbox tools still belong to their existing bundles. HTTP routes and generated
Prisma code remain in `src/routes` and `src/generated`, outside `lib`.

## Lifecycle

Create a Project first, then create its Threads explicitly. Project creation
does not create a conversation. Projects move from `queued` to `ready`; Threads
wait for the environment and then process prompts through `ready -> running ->
ready`. Different Threads can run concurrently without a Thread count,
concurrency, or depth cap.

Interrupt targets one `promptId`, preserves the Thread and subsequent queued
inputs, and does not interrupt children. Rewind replaces an edited turn, so it
requires an idle Thread with an empty queue and discards that turn and every
later one. Terminating a Thread cancels its entire
subtree but leaves other Threads and the Project environment available.
Terminating a Project cancels all its Threads before releasing its lease.
Cancellation is cooperative; it does not undo sandbox changes.

Projects do not expire automatically. Terminate unused Projects to release their
environments. Physical deletion requires terminal state, including descendants,
and discards the Project's durable workspace volume.

A Project survives a host restart. A host stop is not a termination: it releases
the lease, writes the Project back as `queued` (it needs a sandbox again) and its
non-terminal Threads as `ready`, and _pauses_ the prompt that was running — the
prompt stays unfinished, with `prompt.paused { reason: 'host_stopped' }`, so the
next boot takes it up again. The next boot reconciles instead of failing: a
non-terminal Project becomes `queued`, a non-terminal Thread becomes `ready`, and
a prompt whose run started but never recorded a pause gets
`prompt.paused { reason: 'host_restarted' }`, because the restart is what
interrupted it. A record a crash left `cancelling` becomes `cancelled` instead:
reviving it would resurrect work the reader stopped.

That boot also takes up the work itself. For every Project holding a prompt the
host interrupted — one whose pause it recorded, one whose restart only the boot
discovered, or one that never started at all — it acquires the Project's own
sandbox and re-enqueues those prompts in the order the log accepted them, each
opening its next attempt with `prompt.resumed { attempt }`. The queue is restored
before HTTP starts listening, while sandbox acquisition continues in the
background so full capacity cannot block boot. Only such a Project
pays for a sandbox before anyone asks for one; a Project with nothing pending
stays `queued` and acquires nothing. A prompt the host has already taken up twice
is closed as a failure instead, with `resume_exhausted` and a message telling the
reader to send the prompt again, so a host that keeps dying on one prompt stops
circling it. An interrupted prompt resumes from the provider history persisted as
its run advanced — the assistant turns and tool results it already had; a history
that ends in a tool call the restart interrupted is answered before it continues,
and the reader's own input is never repeated. A prompt the reader stopped is the
reader's to take up again, through `POST /threads/:id/resume`, which no budget
bounds.

Acquisition is on demand. Sending a prompt to a Project that has no runtime
reacquires its sandbox first — with the Project's own identity, so it returns to
the same files — sets the Project and its Threads `ready`, and then runs the
prompt, keeping arrival order when several prompts race to bring it back; a read
that needs a lease keeps answering `pending`/`unavailable` and never resumes a
Project by itself, which is what makes the boot resume the one exception.
Terminating a Thread needs no runtime: a Thread of a resumed Project still takes
itself and its subtree through `cancelling -> cancelled` durably, so it can be
deleted without prompting first. Every reacquired sandbox is validated against
each Thread's working directory in one probe, and a directory it no longer holds
is reset to the workspace root. An explicit termination still goes
`cancelling -> cancelled` and stays terminal.

## REST API

| Method    | Path                          | Success   | Purpose                                                |
| --------- | ----------------------------- | --------- | ------------------------------------------------------ |
| GET / PUT | `/config`                     | 200       | Read / replace configuration.                          |
| GET       | `/credentials`                | 200       | List named credentials without their secrets.          |
| POST      | `/credentials`                | 201       | Create a named credential.                             |
| PATCH     | `/credentials/:id`            | 200       | Rename, re-identify, or re-secret a credential.        |
| DELETE    | `/credentials/:id`            | 204 / 409 | Delete an unreferenced credential / refuse one in use. |
| POST      | `/projects`                   | 202       | Reserve an environment without a Thread or prompt.     |
| GET       | `/projects`                   | 200       | List Projects.                                         |
| GET       | `/projects/:id`               | 200       | Read public Project metadata.                          |
| PATCH     | `/projects/:id`               | 200       | Rename a Project.                                      |
| POST      | `/projects/:id/threads`       | 201       | Create a root or child Thread.                         |
| GET       | `/projects/:id/threads`       | 200       | List Threads; optional `parentThreadId` filter.        |
| GET       | `/projects/:id/ssh`           | 200 / 202 | Read private SSH access / wait for environment.        |
| GET       | `/projects/:id/files`         | 200 / 202 | List one workspace directory.                          |
| GET       | `/projects/:id/files/content` | 200 / 202 | Read one workspace file as bounded text.               |
| GET       | `/projects/:id/diff`          | 200 / 202 | Read the workspace Git diff and change list.           |
| POST      | `/projects/:id/terminate`     | 200       | Terminate the Project and its Threads.                 |
| DELETE    | `/projects/:id`               | 204       | Delete a terminal Project.                             |
| GET       | `/threads/:id`                | 200       | Read public Thread metadata.                           |
| PATCH     | `/threads/:id`                | 200       | Rename a Thread or move its working directory.         |
| GET       | `/threads/:id/git`            | 200       | Read the Git summary of the Thread's directory.        |
| POST      | `/threads/:id/prompt`         | 202       | Enqueue human input; returns `promptId`.               |
| POST      | `/threads/:id/resume`         | 202       | Take up a prompt no run has finished; returns Thread.  |
| POST      | `/threads/:id/rewind`         | 202       | Replace an earlier prompt and discard later turns.     |
| GET       | `/threads/:id/events`         | 200       | Replay durable events.                                 |
| POST      | `/threads/:id/interrupt`      | 200       | Interrupt the specified active prompt.                 |
| POST      | `/threads/:id/terminate`      | 200       | Terminate a Thread subtree.                            |
| DELETE    | `/threads/:id`                | 204       | Delete a terminal subtree.                             |
| GET       | `/vms`                        | 200       | List provisioned VM runtimes.                          |
| GET       | `/vms/:id/ssh`                | 200       | Read SSH access associated with `projectId`.           |

Lists use `{ items, nextCursor? }`, with `limit` (1–100, default 50) and an
exclusive UUID `cursor`. Page size does not limit total Projects or Threads.
Public metadata omits message history, prompts, credentials, and SSH keys.
Errors use `{ error: { code, message } }`. Invalid IDs/cursors return 400,
invalid bodies 422, missing resources 404, and lifecycle conflicts 409.

`GET /config` answers `{ configuration, revision, updatedAt }`. The stored
configuration holds no secret: a provider names the `API_TOKEN` credential it
authenticates with, and `gitCredentialId` / `githubCredentialId` name the `GIT`
identity and the `API_TOKEN` GitHub uses. `PUT /config` replaces the whole
configuration and accepts that same shape, so what it answers is what it
accepts. Unknown keys stay rejected (`422 invalid_config`), and a reference that
names an unstored credential or the wrong kind is rejected with the same code.
Configuration saved here reaches the next prompt of any Project, including one
that is already running. A provider kind whose catalog describes its models
declares a models URL, and that catalog is read twice: once when a provider page
asks what its endpoint serves — `POST /providers/models`, which takes the draft's
kind and values and answers every model with its name, its reasoning efforts, the
effort it names as that model's default, whether it pins reasoning on, and the
request parameters it advertises — and again on `PUT /config`, where each listed
model takes the reasoning that catalog describes, a model the catalog does not
name takes none, and the execution effort resolves to the one its model starts at
or is dropped when that model lists none. A catalog that cannot be read leaves
that provider as it was, so an unreachable endpoint never costs the configuration
its model list.

`/credentials` owns the credential store. `GET /credentials` answers
`[{ id, kind, name, username?, email?, hasSecret }]` and never a secret.
`POST` takes a `kind` of `API_TOKEN` (`secret`), `USERNAME_PASSWORD` (`username`
and `secret`), or `GIT` (`username` and `email`), and rejects a field the kind
does not carry. `PATCH` follows one rule per field: absent or `null` keeps it,
`''` clears it, and a value sets it; `kind` is immutable (`409
credential_kind_immutable`), a name already used by the kind is `409`, and a
credential a provider or the configuration references is `409
credential_referenced` on delete. Secrets are stored as AES-256-GCM envelopes
under `DORIC_CREDENTIAL_KEY` (32 base64-encoded bytes); the host refuses to start
when a stored secret exists and that key is missing or unusable.

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

Project creation requires `{ "name": "..." }` and answers with the Project the
host marked with a random color from its palette. Thread creation requires
`{ "name": "..." }` and accepts an optional `parentThreadId`, which starts the
child in its parent's working directory. The Project PATCH requires the
name-only body; the Thread PATCH takes `name`, `cwd`, or both. Names are trimmed,
reject NUL, and contain 1–80 Unicode characters. The prompt body accepts only
`prompt`. Public callers cannot forge parent/result origins or correlation.
Rewind accepts only `{ "promptId", "prompt" }` and answers `202 { promptId }`
like a prompt. It removes the named turn and every later turn from the durable
event log and the provider-ready history, then accepts the edited text as a new
human input. Each turn records the provider-history length it started from, so
rewind truncates exactly at that turn boundary. A Thread that is running or has
queued input refuses with `409 thread_busy`, so queued work never runs on
truncated history; a `promptId` without a recorded turn in that Thread returns
`404 prompt_not_found`. Sequence numbers are never reused.
A stale interrupt returns `409 thread_not_running`, never cancelling a later
execution. Resume accepts only `{ "promptId" }` and answers `202` with the Thread;
it re-enqueues that one prompt — bringing the Project's sandbox back when the host
holds none — and appends the next `prompt.resumed` attempt. A prompt the Thread
has not left unfinished is `404 prompt_not_found`, one it already holds running or
queued is `409 thread_busy`, and a Project that cannot run is `409
thread_inactive`. `GET /projects/:id/ssh` returns 202 with `Retry-After: 1` while
pending, 409 when unavailable, and 410 when expired. SSH responses forbid caches.

`GET /projects/:id/files`, `/files/content`, and `/diff` share those lease
answers: `202` with `Retry-After: 1` while the environment is pending, `409`
when unavailable, and `410` when expired. A workspace-relative `path` is
normalised, resolved against the workspace root, and rejected with `422` when it
escapes; a missing path is `404`. Content is capped at 256 KiB (`CONTENT_LIMIT_BYTES`)
and reported with `truncated` and `binary` flags, so a binary file is never
rendered as mangled text. A Git diff never contains untracked files, so the
`changes` list supplies them alongside `diff`. A `path` on `/diff` also scopes
discovery: the repositories it reads are the ones that path belongs to or holds,
which is how one Thread reads the changes of its own working directory.

### The Thread working directory

Every Thread owns a working directory inside its Project's shared sandbox. It
starts at `/workspace`, and the agent moves it with its `cwd` tool, which calls
the same rule the HTTP route does. `PATCH /threads/:id` takes an optional `cwd`:
an absolute sandbox path, or one relative to the Thread's current directory the
way `cd` reads it. A move that would leave the workspace root answers
`400 { code: 'invalid_cwd' }`, and so does one that names no directory or names a
file; a valid move answers the updated Thread. The Thread record carries the
directory as `cwd` plus a cheap hint as `cwdRepo`: absent unless the directory's
own root holds a `.git` marker, then `github` when that repository's `origin`
points at github.com and `git` otherwise. The hint is an observation, refreshed
whenever the directory moves, when one of the Thread's prompts settles, and when
the Git summary below is read — and `thread:updated` is published only when it
really changed. When a Project reacquires a sandbox, every Thread whose directory
is not the workspace root is checked in one probe: a directory the sandbox no
longer holds — missing, no longer a directory, or resolving outside the root — is
reset to `/workspace` with its hint cleared, and one `thread:updated` is published
for each reset. Only an explicit negative answer resets a directory: a probe that
cannot run keeps every stored directory, because a command that failed is not
evidence that the directories are gone.

`GET /threads/:id/git` answers the Git summary of the Thread's working directory:
`{ repo: false }` when the directory holds, or lies in, no repository, else its
`root`, `head` (the branch, or the short commit when HEAD is detached),
`detached`, `unborn`, `upstream`, `ahead`, `behind`, `dirty`
(`staged`/`modified`/`untracked`), `conflicted`, `operation`
(`merge`/`rebase`/`cherry-pick`/`revert`/`bisect`), `worktree`, `shallow`, and
`stash` count. One sandbox command per probe reads all of it — a
`git status --porcelain=v2 --branch` document whose headers already carry the
branch, its upstream, and the ahead/behind counts, plus the labeled facts a small
shell script prints around it — and the answer is cached per Thread until the
directory moves, a prompt settles, or the renderer asks for it. Like the other
lease-bound resources, the route answers `409` while the Project's sandbox is not
readable, and `404` for an unknown Thread.

The existing CLI now uses these operations:

```sh
npm run doric:spawn-agent -- --url http://127.0.0.1:3000 \
  --prompt "Inspect the workspace" --terminate
```

It creates Project then Thread, submits input, polls durable replay, and prints
only IDs, event metadata, and the Project SSH URL. Without `--terminate`, the
Project remains reserved. Configure `/config` and server credentials separately;
the client does not send credentials or A2A configuration.

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

| Namespace               | Event              | Payload                                                |
| ----------------------- | ------------------ | ------------------------------------------------------ |
| `/status`               | `connect`          | None; confirms that the Doric host is reachable.       |
| `/threads`              | `thread:snapshot`  | `{ threadId, projectId, project, thread, events }`     |
| `/threads`              | `agent:event`      | Complete persisted Thread event envelope.              |
| `/threads`, `/projects` | `thread:updated`   | Public Thread metadata.                                |
| `/threads`, `/projects` | `thread:deleted`   | `{ projectId, threadId }`                              |
| `/projects`             | `project:snapshot` | `{ projectId, project, threads }`                      |
| `/projects`             | `project:updated`  | Public Project metadata.                               |
| `/projects`             | `project:deleted`  | `{ projectId }`                                        |
| `/threads`, `/projects` | `workspace:error`  | Sanitized `{ code, message }`; connection then closes. |

`/status` requires no parameters and emits no application payload. Reuse one
`Manager` for `/status` and the Project subscription so they share one Engine.IO
connection, and give each watched Thread a `Manager` of its own: closing that
connection is what ends the Thread's subscription.

Missing snapshot resources are `null`. The Project snapshot contains the full
Thread tree as a flat array with `parentThreadId` links. Project reconnection
resnapshots that tree; execution history is replayed separately per Thread.
Thread subscriptions are installed before durable replay, buffer live events
and lifecycle notifications, and deduplicate by sequence. Clients reconnect
with their last received sequence.

Each accepted input emits `prompt.accepted` with `{ type, text, source }`; `text`
is the input after configured-credential redaction and `source` is its trusted
origin. The host emits `prompt.finished` with `{ type, status, text, source }`;
`status` is `completed`, `failed`, or `cancelled`. Success is acknowledged only
after conversation history is saved. Use this event, not the inner
`agent.finished`. A persistence failure can instead make the Thread terminal
with `persistence_failed`; clients must also observe Thread state.

An interruption that leaves a prompt unfinished emits `prompt.paused` with
`{ type, reason }`, where `reason` is `host_stopped` when the host stopped,
`host_restarted` when a boot discovered the restart a run never recorded, and
`reader_stopped` when the reader stopped the run. A prompt that never started is
left without one: it was never running. The host takes its own interruptions up
again by appending `prompt.resumed` with `{ type, attempt }`, counting from `1`,
and a reader's own resume of the same prompt does the same under the prompt's own
`promptId`: a resumable prompt is unfinished, and a client that sees one — no
`prompt.finished`, and a pause or a `prompt.resumed` as its last word — can offer
the reader `POST /threads/:id/resume`.

Delegated results are queued automatically for the parent without interrupting
its current prompt. They can trigger additional model/tool activity. The
`--terminate` client option closes the entire Project after its submitted
prompt ends, including any still-running descendants; omit it to keep those
conversations available.

## Docker deploy

[`compose.yaml`](compose.yaml) runs the host with PostgreSQL. Copy
[`.env.example`](.env.example) to `agents/doric/.env` and fill in real values;
that file is git-ignored and is the only place these secrets should live.

```sh
cp agents/doric/.env.example agents/doric/.env   # then edit it
cd agents/doric
docker compose --profile docker build
docker compose --profile docker up -d
```

Compose starts three services: `postgres` (durable volume), `migrate` (one-shot
`prisma migrate deploy`), and `doric`. The `firecracker` profile replaces the
Docker provider and needs `/dev/kvm` plus privileged mode. Confirm the deploy
from the host log (`Bundles loaded` reports bundle, tool, and skill counts) and
`GET /projects`.

The Docker profile runs sandboxes from the sandbox image built from
[`.sandbox.Dockerfile`](.sandbox.Dockerfile), which adds the GitHub CLI to the
base image's Git. Compose selects it through `DORIC_SANDBOX_IMAGE`
(`doric-sandbox:local` by default) and the host otherwise provisions the plain
`node:22-bookworm` image, so build the tag before `up`:

```sh
# from the repository root, before `docker compose --profile docker up`
docker build -f agents/doric/.sandbox.Dockerfile -t doric-sandbox:local agents/doric
```

Build it first: the provider pulls an image only when it is absent locally, so a
tag that was never built fails the pool's image pull instead of silently falling
back to the plain Node image. The `firecracker` profile resolves an anonymous
**public** OCI image rather than a local tag, so it can only use this image once
the tag is published or `DORIC_SANDBOX_IMAGE` is pointed at a public image.

Two traps break the image build or the deployed catalog:

- every bundle must also appear in `agents/doric/.Dockerfile`: its `tsc --build`
  list and the resource copies. The Direct host loads whatever the image puts in
  `agents/doric/dist/bundles`, so a bundle missing there is silently absent at
  runtime;
- `package-lock.json` must be generated with the npm major the build image runs
  (`node:22-bookworm-slim` ships npm 10). A lock rewritten by a newer local npm
  fails `npm ci` with `Missing: <package> from lock file`; regenerate it with
  `npx npm@10 install --package-lock-only`.

To replace the PostgreSQL password of an existing deployment without losing
data, alter the role through the container's trusted local socket instead of
recreating the volume:

```sh
docker exec -it doric-sandbox-postgres-1 \
  psql -U doric -h 127.0.0.1 -d doric -c "ALTER ROLE doric WITH PASSWORD 'NEW'"
```

## Persistence and security

PostgreSQL stores Projects, Threads, messages, configuration snapshots, and
Thread events. Apply migrations separately with `npx nx run doric:migrate`;
startup does not apply them. The migration history starts with the clean
Project/Thread baseline, bootstrap configuration, singleton constraint, and
immutable-tree trigger. The following incremental migration adds and backfills
Project and Thread names, the next adds the per-turn provider-history
checkpoints that rewind truncates, then the Project color, the nullable
GitHub identity and token columns, and last the credential store that replaces
them. It does not convert Session data.

Use an empty database. A database with the old schema or migration history
must be explicitly recreated by its operator before deployment. Neither the
host nor the baseline deletes or resets an existing database automatically.

The API is unauthenticated. Keep it on an isolated trusted network, especially
because SSH responses and execution replay contain sensitive material. Provider
credential values belong in the credential store, never configuration
JSON or client requests.

The host owns one credential store for every secret it holds. Each credential is
named and has a kind that fixes its fields: `API_TOKEN` is authentication, which
a provider key and the GitHub token both are, `USERNAME_PASSWORD` is
authentication with a name, and `GIT` is the identity the agent's git commands
commit with and holds no secret. A secret is stored as an AES-256-GCM envelope
under `DORIC_CREDENTIAL_KEY` and is never answered over the API; the host
redacts every stored secret from events and logs before persistence and keeps it
out of tool payloads. The credential store is created by migration from the
former provider environment names and the former GitHub columns, so every
provider keeps its row with a credential whose secret is empty until its
operator fills it, and the former plaintext GitHub token is re-entered once.

The host applies the Git identity and the GitHub token to a Project's sandbox:
`git config --global` for the identity, and, when a token is configured,
`credential.helper store` plus a
`~/.git-credentials` written 0600, and a `~/.config/gh/hosts.yml` written 0600 so
the token authenticates the sandbox's `gh`. That happens when a lease is
acquired and
again whenever the current pair differs from the one the sandbox holds, because
the chosen credentials follow the current configuration while every other value
stays
captured per Project. The token travels only through the sandbox process
environment, so it never appears in a tool argument, a tool result, an event, or
a log line; a write that fails is a warning naming the Project and nothing else.

## Storage protection

The host checks available filesystem blocks before dispatch and every three
seconds during execution. At **10% free or less**, or when the configured path
cannot be measured, execution pauses and the queue shows an error. Free space
above 10%, then resume the queue; recovery never starts automatically.

Compose sets `DORIC_STORAGE_PATH=/var/lib/doric/postgresql` and mounts its
PostgreSQL volume there read-only. Native runs default to the current directory;
set this variable to a path on the actual database filesystem. A local path does
not measure a remote PostgreSQL server. Remote deployments require a mount on
that filesystem for proactive protection; PostgreSQL disk-full errors are still
handled as pauses independently of the probe.

If the disk is already completely full, the host retains any unsaved history and
event in memory and refuses to resume until it can save them. Keep that host
process alive while freeing space; a process crash cannot preserve unsaved data.

## Validation

Run `npx nx run doric:test` for the host suite and `npx nx run agent:test`
for the reusable loop. `doric:test` also builds the bundled tools.

To include persistence and the composed Docker workflow, supply
`DORIC_TEST_DATABASE_URL` pointing to a dedicated PostgreSQL test instance and
set `DORIC_TEST_SANDBOX=true`. The tests create isolated schemas and a disposable
Docker sandbox; only the external LLM is scripted. Without these variables,
the external-infrastructure cases explicitly skip.

The client workflow tests run with
`node --test scripts/tests/spawn-agent.test.mjs`.
