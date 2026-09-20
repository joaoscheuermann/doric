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
│   ├── prompts/system.ts
│   └── tools/
│       ├── index.ts
│       ├── spawn-thread.ts
│       ├── send-to-thread.ts
│       ├── list-threads.ts
│       ├── get-thread.ts
│       ├── interrupt-thread.ts
│       └── terminate-thread.ts
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
│   ├── coordination.ts
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
appends bundle skills in their declared order. Each coordination tool owns its
definition, schemas, and adapter in one file. Shared lifecycle and authorization
remain in `workspace`, behind the injected coordination contract.
Sandbox tools still belong to their existing bundles. HTTP routes and generated
Prisma code remain in `src/routes` and `src/generated`, outside `lib`.

## Lifecycle

Create a Project first, then create its Threads explicitly. Project creation
does not create a conversation. Projects move from `queued` to `ready`; Threads
wait for the environment and then process prompts through `ready -> running ->
ready`. Different Threads can run concurrently without a Thread count,
concurrency, or depth cap.

Interrupt targets one `promptId`, preserves the Thread and subsequent queued
inputs, and does not interrupt children. Terminating a Thread cancels its entire
subtree but leaves other Threads and the Project environment available.
Terminating a Project cancels all its Threads before releasing its lease.
Cancellation is cooperative; it does not undo sandbox changes.

Projects do not expire automatically. Terminate unused Projects to release their
environments. Physical deletion requires terminal state, including descendants.
After a server restart, interrupted work is marked failed rather than resumed.

## REST API

| Method    | Path                      | Success   | Purpose                                            |
| --------- | ------------------------- | --------- | -------------------------------------------------- |
| GET / PUT | `/config`                 | 200       | Read / replace credential-free configuration.      |
| POST      | `/projects`               | 202       | Reserve an environment without a Thread or prompt. |
| GET       | `/projects`               | 200       | List Projects.                                     |
| GET       | `/projects/:id`           | 200       | Read public Project metadata.                      |
| POST      | `/projects/:id/threads`   | 201       | Create a root or child Thread.                     |
| GET       | `/projects/:id/threads`   | 200       | List Threads; optional `parentThreadId` filter.    |
| GET       | `/projects/:id/ssh`       | 200 / 202 | Read private SSH access / wait for environment.    |
| POST      | `/projects/:id/terminate` | 200       | Terminate the Project and its Threads.             |
| DELETE    | `/projects/:id`           | 204       | Delete a terminal Project.                         |
| GET       | `/threads/:id`            | 200       | Read public Thread metadata.                       |
| POST      | `/threads/:id/prompt`     | 202       | Enqueue human input; returns `promptId`.           |
| GET       | `/threads/:id/events`     | 200       | Replay durable events.                             |
| POST      | `/threads/:id/interrupt`  | 200       | Interrupt the specified active prompt.             |
| POST      | `/threads/:id/terminate`  | 200       | Terminate a Thread subtree.                        |
| DELETE    | `/threads/:id`            | 204       | Delete a terminal subtree.                         |
| GET       | `/vms`                    | 200       | List provisioned VM runtimes.                      |
| GET       | `/vms/:id/ssh`            | 200       | Read SSH access associated with `projectId`.       |

Lists use `{ items, nextCursor? }`, with `limit` (1–100, default 50) and an
exclusive UUID `cursor`. Page size does not limit total Projects or Threads.
Public metadata omits message history, prompts, credentials, and SSH keys.
Errors use `{ error: { code, message } }`. Invalid IDs/cursors return 400,
invalid bodies 422, missing resources 404, and lifecycle conflicts 409.

### Create and converse

```sh
curl -X POST http://127.0.0.1:3000/projects
# Use the returned Project id:
curl -X POST http://127.0.0.1:3000/projects/PROJECT_ID/threads
# For a child, supply {"parentThreadId":"PARENT_THREAD_ID"} instead.
curl -X POST -H 'content-type: application/json' \
  -d '{"prompt":"Inspect the repository and run focused tests."}' \
  http://127.0.0.1:3000/threads/THREAD_ID/prompt
curl -X POST -H 'content-type: application/json' \
  -d '{"promptId":"PROMPT_ID"}' \
  http://127.0.0.1:3000/threads/THREAD_ID/interrupt
curl -X POST http://127.0.0.1:3000/projects/PROJECT_ID/terminate
```

The creation body accepts only `parentThreadId`; the prompt body accepts only
`prompt`. Public callers cannot forge parent/result origins or correlation.
A stale interrupt returns `409 thread_not_running`, never cancelling a later
execution. `GET /projects/:id/ssh` returns 202 with `Retry-After: 1` while
pending, 409 when unavailable, and 410 when expired. SSH responses forbid caches.

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

## Socket.IO

```ts
import { io } from 'socket.io-client';

const thread = io('http://127.0.0.1:3000/threads', {
  query: { threadId, afterSequence: 42 },
});
const project = io('http://127.0.0.1:3000/projects', {
  query: { projectId },
});
```

| Namespace   | Event              | Payload                                                |
| ----------- | ------------------ | ------------------------------------------------------ |
| `/threads`  | `thread:snapshot`  | `{ threadId, projectId, project, thread, events }`     |
| `/threads`  | `agent:event`      | Complete persisted Thread event envelope.              |
| both        | `thread:updated`   | Public Thread metadata.                                |
| both        | `thread:deleted`   | `{ projectId, threadId }`                              |
| `/projects` | `project:snapshot` | `{ projectId, project, threads }`                      |
| `/projects` | `project:updated`  | Public Project metadata.                               |
| `/projects` | `project:deleted`  | `{ projectId }`                                        |
| both        | `workspace:error`  | Sanitized `{ code, message }`; connection then closes. |

Missing snapshot resources are `null`. The Project snapshot contains the full
Thread tree as a flat array with `parentThreadId` links. Project reconnection
resnapshots that tree; execution history is replayed separately per Thread.
Thread subscriptions are installed before durable replay, buffer live events
and lifecycle notifications, and deduplicate by sequence. Clients reconnect
with their last received sequence.

Each accepted input emits `prompt.accepted` with its trusted origin. The host
emits `prompt.finished` with `{ type, status, text, source }`; `status` is
`completed`, `failed`, or `cancelled`. Success is acknowledged only after
conversation history is saved. Use this event, not the inner
`agent.finished`. A persistence failure can instead make the Thread terminal
with `persistence_failed`; clients must also observe Thread state.

Delegated results are queued automatically for the parent without interrupting
its current prompt. They can trigger additional model/tool activity. The
`--terminate` client option closes the entire Project after its submitted
prompt ends, including any still-running descendants; omit it to keep those
conversations available.

## Persistence and security

PostgreSQL stores Projects, Threads, messages, configuration snapshots, and
Thread events. Apply migrations separately with `npx nx run doric:migrate`;
startup does not apply them. The cutover uses a single clean Project/Thread
baseline generated from the current Prisma schema, plus bootstrap
configuration, its singleton constraint, and the immutable-tree trigger.
It does not convert Session data or retain old migrations.

Use an empty database. A database with the old schema or migration history
must be explicitly recreated by its operator before deployment. Neither the
host nor the baseline deletes or resets an existing database automatically.

The API is unauthenticated. Keep it on an isolated trusted network, especially
because SSH responses and execution replay contain sensitive material. Provider
credential values belong in server environment variables, never configuration
JSON or client requests.

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
