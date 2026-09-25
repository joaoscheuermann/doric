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
├── workspace/
│   ├── types.ts
│   ├── service.ts
│   ├── runtime.ts
│   ├── runner.ts
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
(`spawn_thread`, `list_threads`, `get_thread`, `send_to_thread`,
`interrupt_thread`, `terminate_thread`) ship in the `/bundles/threads` bundle and
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
environments. Physical deletion requires terminal state, including descendants.
After a server restart, interrupted work is marked failed rather than resumed.

## REST API

| Method    | Path                          | Success   | Purpose                                            |
| --------- | ----------------------------- | --------- | -------------------------------------------------- |
| GET / PUT | `/config`                     | 200       | Read / replace configuration and GitHub identity.  |
| POST      | `/projects`                   | 202       | Reserve an environment without a Thread or prompt. |
| GET       | `/projects`                   | 200       | List Projects.                                     |
| GET       | `/projects/:id`               | 200       | Read public Project metadata.                      |
| PATCH     | `/projects/:id`               | 200       | Rename a Project.                                  |
| POST      | `/projects/:id/threads`       | 201       | Create a root or child Thread.                     |
| GET       | `/projects/:id/threads`       | 200       | List Threads; optional `parentThreadId` filter.    |
| GET       | `/projects/:id/ssh`           | 200 / 202 | Read private SSH access / wait for environment.    |
| GET       | `/projects/:id/files`         | 200 / 202 | List one workspace directory.                      |
| GET       | `/projects/:id/files/content` | 200 / 202 | Read one workspace file as bounded text.           |
| GET       | `/projects/:id/diff`          | 200 / 202 | Read the workspace Git diff and change list.       |
| POST      | `/projects/:id/terminate`     | 200       | Terminate the Project and its Threads.             |
| DELETE    | `/projects/:id`               | 204       | Delete a terminal Project.                         |
| GET       | `/threads/:id`                | 200       | Read public Thread metadata.                       |
| PATCH     | `/threads/:id`                | 200       | Rename a Thread.                                   |
| POST      | `/threads/:id/prompt`         | 202       | Enqueue human input; returns `promptId`.           |
| POST      | `/threads/:id/rewind`         | 202       | Replace an earlier prompt and discard later turns. |
| GET       | `/threads/:id/events`         | 200       | Replay durable events.                             |
| POST      | `/threads/:id/interrupt`      | 200       | Interrupt the specified active prompt.             |
| POST      | `/threads/:id/terminate`      | 200       | Terminate a Thread subtree.                        |
| DELETE    | `/threads/:id`                | 204       | Delete a terminal subtree.                         |
| GET       | `/vms`                        | 200       | List provisioned VM runtimes.                      |
| GET       | `/vms/:id/ssh`                | 200       | Read SSH access associated with `projectId`.       |

Lists use `{ items, nextCursor? }`, with `limit` (1–100, default 50) and an
exclusive UUID `cursor`. Page size does not limit total Projects or Threads.
Public metadata omits message history, prompts, credentials, and SSH keys.
Errors use `{ error: { code, message } }`. Invalid IDs/cursors return 400,
invalid bodies 422, missing resources 404, and lifecycle conflicts 409.

`GET /config` answers `{ configuration, revision, updatedAt }` and never the
GitHub token: a configured identity reads back as
`configuration.github = { username, email, hasToken }`, and `github` itself is
absent until it is configured. `PUT /config` replaces the whole configuration
and accepts those fields plus an optional `github: { username, email, token }`,
where `username` and `email` are required together because an identity without
them is useless, and the token is optional so a public-only identity is
configurable. The GitHub block follows one rule: absent leaves the stored block
alone, `null` removes it, and a value sets it. Inside a value, an absent or
`null` token keeps the stored one, `""` clears just the token, and any other
value replaces it, so a secret is never deleted by omission. Unknown keys stay
rejected (`422 invalid_config`), and only configuration saved here reaches
Projects created afterwards.

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
curl -X POST http://127.0.0.1:3000/projects/PROJECT_ID/terminate
```

Project creation requires `{ "name": "..." }` and answers with the Project the
host marked with a random color from its palette. Thread creation requires
`{ "name": "..." }` and accepts an optional `parentThreadId`. Both PATCH
operations require the same name-only body. Names are trimmed, reject NUL, and
contain 1–80 Unicode characters. The prompt body accepts only `prompt`. Public
callers cannot forge parent/result origins or correlation.
Rewind accepts only `{ "promptId", "prompt" }` and answers `202 { promptId }`
like a prompt. It removes the named turn and every later turn from the durable
event log and the provider-ready history, then accepts the edited text as a new
human input. Each turn records the provider-history length it started from, so
rewind truncates exactly at that turn boundary. A Thread that is running or has
queued input refuses with `409 thread_busy`, so queued work never runs on
truncated history; a `promptId` without a recorded turn in that Thread returns
`404 prompt_not_found`. Sequence numbers are never reused.
A stale interrupt returns `409 thread_not_running`, never cancelling a later
execution. `GET /projects/:id/ssh` returns 202 with `Retry-After: 1` while
pending, 409 when unavailable, and 410 when expired. SSH responses forbid caches.

`GET /projects/:id/files`, `/files/content`, and `/diff` share those lease
answers: `202` with `Retry-After: 1` while the environment is pending, `409`
when unavailable, and `410` when expired. A workspace-relative `path` is
normalised, resolved against the workspace root, and rejected with `422` when it
escapes; a missing path is `404`. Content is capped at 256 KiB (`CONTENT_LIMIT_BYTES`)
and reported with `truncated` and `binary` flags, so a binary file is never
rendered as mangled text. A Git diff never contains untracked files, so the
`changes` list supplies them alongside `diff`.

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
redacted before persistence. Full prompt/event payloads are not operational logs.

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
const thread = manager.socket('/threads', {
  auth: { threadId, afterSequence: 42 },
});
const project = manager.socket('/projects', { auth: { projectId } });
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
`Manager` for `/status` and workspace subscriptions so they share one Engine.IO
connection.

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
checkpoints that rewind truncates, then the Project color, and last the nullable
GitHub identity and token columns. It does not convert Session data.

Use an empty database. A database with the old schema or migration history
must be explicitly recreated by its operator before deployment. Neither the
host nor the baseline deletes or resets an existing database automatically.

The API is unauthenticated. Keep it on an isolated trusted network, especially
because SSH responses and execution replay contain sensitive material. Provider
credential values belong in server environment variables, never configuration
JSON or client requests.

The one configuration secret is the GitHub token. The host stores it rather
than handing it to a sandbox tool: it is write-only over the API, redacted from
events and logs before persistence, and carried in the captured configuration
snapshot of every Project created after it was saved, so a Project's own events
redact it too. `PUT /config` treats the GitHub block as absent (leave it alone),
`null` (remove it), or a value (set it), so no caller can delete the token by
leaving the key out.

The host applies that block to a Project's sandbox: `git config --global` for
the identity, and, when a token is configured, `credential.helper store` plus a
`~/.git-credentials` written 0600, and a `~/.config/gh/hosts.yml` written 0600 so
the same token authenticates the sandbox's `gh`. That happens when a lease is
acquired and
again whenever the current block differs from the one the sandbox holds, because
the GitHub block follows the current configuration while every other value stays
captured per Project. The token travels only through the sandbox process
environment, so it never appears in a tool argument, a tool result, an event, or
a log line; a write that fails is a warning naming the Project and nothing else.

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
