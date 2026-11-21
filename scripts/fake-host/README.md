# The development fake host

The fake host is a Node script that stands in for the Doric host so the real
desktop app can open a workspace with no PostgreSQL, no Docker sandbox and no
model provider. It serves the repository's own staged bundles, an in-memory
workspace that starts with two Projects, a seeded conversation and the
`comments/v1` registry, over HTTP and the Socket.IO namespace `/doric/bridge`
([`main.mjs`](main.mjs), [`server.mjs`](server.mjs)). It is a development
tool: the host and the packaged app import nothing from this directory; the
test [`tests/fake-host-bundles.test.mjs`](../../tests/fake-host-bundles.test.mjs)
imports [`bundles.mjs`](bundles.mjs).

For the real host and the desktop, see the
[host README](../../app/backend/doric-host/README.md) and the
[desktop README](../../app/desktop/doric/README.md). The features it fakes are
described in [Projects and Threads](../../docs/features/projects-and-threads.md)
and [Comments](../../docs/features/comments.md).

## Run it

1. Install the dependencies (`npm install`) and build the `bundle` package
   (`npx nx run bundle:build`): the script imports `bundle` and
   `bundle/runtime`, which Node resolves to `packages/bundle/dist`, and
   `socket.io` ([`bundles.mjs`](bundles.mjs), [`server.mjs`](server.mjs)).
2. Build and stage the bundles with `npx nx run doric-host:build-bundles`,
   which writes `app/backend/doric-host/dist/bundles`. Without that directory
   the fake host stages the built bundles itself (see [Boot](#boot)). The
   fallback needs the bundles built but not staged:
   `npx nx run-many -t build -p tag:type:bundle`
   ([`bundles.mjs`](bundles.mjs)).
3. Start it:

   ```sh
   npm run doric:fake-host
   ```

   This runs `node scripts/fake-host/main.mjs` ([`package.json`](../../package.json)).
   It prints the URL it listens on and the command that points the desktop
   at it ([`main.mjs`](main.mjs)):

   ```sh
   DORIC_HOST_URL=http://127.0.0.1:3000 DISPLAY=:100 npm run doric:dev
   ```

4. After changing a bundle, rebuild it (`npx nx run doric-host:build-bundles`)
   and request `GET /reload`. Reload rebuilds the catalog from the bundles root
   chosen at boot and does not resolve or stage it again
   ([`main.mjs`](main.mjs)). When the fake host started from the staged copy
   under `tmp/fake-host/bundles`, restart it. When `--bundles` or
   `DORIC_FAKE_BUNDLES` names another directory, stage the bundles into it
   (`node packages/bundle/dist/build/cli.js stage <dir> --all bundles`) and
   request `GET /reload`.

Stop it with Ctrl-C or `SIGTERM`: it logs `stopping on <signal>`, closes the
Socket.IO server and the HTTP server it is attached to, and exits with code 0
([`main.mjs`](main.mjs)).

## Command line and environment

```sh
node scripts/fake-host/main.mjs [--port <n>] [--host <address>] [--bundles <dir>] [--composition <file>] [--quiet]
```

A value flag takes the next argument, even when that argument is another flag
(`--bundles --quiet` sets the bundles root to `--quiet`, and still turns quiet
mode on); a value flag given
last, with no argument after it, falls back to its environment variable or
default. A flag
wins over its environment variable, which wins over the default
([`main.mjs`](main.mjs)).

| Flag            | Environment variable                    | Default                                                                                                                   | What it changes                                                                                                               |
| --------------- | --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `--port`        | `DORIC_FAKE_PORT`, then `DORIC_PORT`    | `3000`                                                                                                                    | The TCP port, converted with `Number`.                                                                                        |
| `--host`        | `DORIC_FAKE_HOST`                       | `127.0.0.1`                                                                                                               | The address to bind; also the host part of the printed URL.                                                                   |
| `--bundles`     | `DORIC_FAKE_BUNDLES`                    | `app/backend/doric-host/dist/bundles` in the repository, else a staged copy under the repository root (see [Boot](#boot)) | The staged bundles root the catalog is built from; a given value is resolved against the working directory and must exist.    |
| `--composition` | `DORIC_FAKE_COMPOSITION`                | `app/backend/doric-host/composition.json` in the repository                                                               | The composition the catalog resolves; a given value is resolved against the working directory.                                |
| `--quiet`       | `DORIC_FAKE_QUIET` (only the value `1`) | off                                                                                                                       | Drops the per-call `→` and `✓` lines; notes, REST lines, failures and unknown calls are still printed ([`log.mjs`](log.mjs)). |

## Boot

In order ([`main.mjs`](main.mjs)):

1. Reads the flags and environment above.
2. Resolves the bundles root ([`bundles.mjs`](bundles.mjs)):
   - an explicit `--bundles` or `DORIC_FAKE_BUNDLES` is used when it exists;
     otherwise boot fails with `No staged bundles at <dir>.`;
   - else `app/backend/doric-host/dist/bundles`, when it exists;
   - else every `bundles/<group>/<id>` directory of the repository holding a
     `manifest.json` is staged into `tmp/fake-host/bundles` under the
     repository root (git-ignored): each bundle's `dist` replaces
     `tmp/fake-host/bundles/<manifest id>`, without `.tsbuildinfo` files. It
     logs `no staged bundles at <dir>: staging <n> bundles into <dest>`.
     Staging fails with
     `<bundleDir>: dist/manifest.json is missing; build the bundle first`
     when a bundle is not built.

   When resolution fails, it writes the message and
   ``Build the bundles with `npx nx run doric-host:build-bundles`, or point DORIC_FAKE_BUNDLES at a staged directory.``
   to stderr and exits with code 1.

3. Builds catalog generation 1 (see [The catalog](#the-catalog)). A
   composition or bundle that cannot be read rejects the start: Node prints
   the error's stack to stderr and exits with code 1.
4. Creates the workspace, the Thread log and the comment registry, and seeds
   the conversation (see [Data](#data)).
5. Starts the HTTP server with the REST routes and the Socket.IO namespace
   `/doric/bridge` ([`server.mjs`](server.mjs)). When the port is taken
   (`EADDRINUSE`), it writes
   `[fake-host] <host>:<port> is already in use: another host (or a fake host from an earlier shell) holds it.`
   and `[fake-host] Free the port, or start this one elsewhere: DORIC_FAKE_PORT=3010 npm run doric:fake-host`
   to stderr and exits with code 1. On any other listen error Node prints the
   error's stack to stderr and exits with code 1.
6. Logs the bundles root with its bundle count and generation, the
   composition path, `fake host listening on <url>`,
   `bridge namespace <url>/doric/bridge` and the desktop command.

## The catalog

One catalog is built per generation from the staged bundles root and the
composition, with the `bundle` package's own functions
([`bundles.mjs`](bundles.mjs)):

1. `discoverBundles` reads the installed bundles, `readComposition` the
   composition, and `buildCatalog` resolves them with no embedded bundles and
   the package's `PLATFORM_VERSION`.
2. Every resolved bundle is set to the state `active` in a `DiagnosticsStore`:
   the fake host runs no activation, and the desktop leaves a bundle that is
   not active out of the window.
3. `distributionFor` builds the distribution the desktop downloads, with a
   host boot id `dev-<start time in base 36>` fixed for the process
   ([`main.mjs`](main.mjs)).
4. Each distributed file of an installed bundle is indexed by its SHA-256 to
   its path under the bundle's staged directory.

`GET /reload` builds generation `current + 1` the same way, from the bundles
root chosen at boot, without resolving or staging it again, makes it current
and pushes `{ generation }` to every `doric.catalog/v1.watch` subscriber
([`main.mjs`](main.mjs)). The workspace, the Thread log and the comments are
not part of the catalog and survive a reload.

## Logging

Every line goes to stdout as `[fake-host] <HH:MM:SS.mmm> <text>`, the time of
day in UTC
([`log.mjs`](log.mjs)):

| Line                                                   | When                                                                                                              | Printed with `--quiet` |
| ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------- | ---------------------- |
| a note                                                 | boot, seeding, a REST answer (`rest GET <path> → <status>`), a desktop connecting, a prompt, a comment, `disable` | yes                    |
| `→ <contract> <method> <input>`                        | a bridge call or subscription a handler serves                                                                    | no                     |
| `✓ <contract> <method> (<ms> ms)`                      | a call answered, or a stream ended                                                                                | no                     |
| `✗ <contract> <method>: <message>`                     | a handler threw                                                                                                   | yes                    |
| `?? UNKNOWN <contract> <method> <input> → unavailable` | a call or subscription no handler serves                                                                          | yes                    |

The input is printed as JSON, cut to 160 characters with `…`, or `(none)`.
The `?? UNKNOWN` lines list what the desktop asks for that the fake host does
not serve.

## REST routes

These routes are the fake host's own: only `GET /projects` and
`GET /projects/:id` share a path with the host's REST API, and
`GET /projects` ignores its query. Every route answers JSON with
`content-type: application/json`
([`server.mjs`](server.mjs)). Any method other than `GET`, on any path,
answers `405` with `{ "error": { "message": "The development fake host is read-only." } }`.

| Route                         | Answer                                                                                                                                     |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `GET /`, `GET /status`        | `200` `{ status: "ok", service: "doric-fake-host", version: "dev", generation, bundles: [bundle ids] }`                                    |
| `GET /projects`               | `200` `{ items, nextCursor? }`: the first 100 Projects ([`workspace.mjs`](workspace.mjs))                                                  |
| `GET /projects/:id`           | `200` the Project, or `404` `{ error: { message: "The project was not found." } }`                                                         |
| `GET /threads?projectId=<id>` | `200` `{ items }`: the first 100 Threads of the Project; empty without `projectId` or for an unknown one                                   |
| `GET /reload`                 | `200` `{ generation }` after the rebuild; `500` `{ error: { message } }` when the rebuild fails, and the previous generation stays current |
| any other `GET`               | `404` `{ error: { message: "No <path> on the fake host." } }`                                                                              |

## The bridge

A Socket.IO server is attached to the same HTTP server, on its default path,
`/socket.io/`,
without serving the client script; only the namespace `/doric/bridge` is
opened. Each connection is logged `bridge: a desktop connected (<socket id>)`
([`server.mjs`](server.mjs)).

| Direction      | Event                   | Payload                                                                                                     | What happens                                                                                                                     |
| -------------- | ----------------------- | ----------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| desktop → host | `call`                  | `{ id, contract, method, input, scope? }`                                                                   | The handler for `<contract> <method>` runs with the input and `{ scope }`; its value is answered as `result`.                    |
| host → desktop | `result`                | `{ kind: "result", id, ok: true, output }` or `{ kind: "result", id, ok: false, error: { code, message } }` | One per `call`.                                                                                                                  |
| desktop → host | `subscribe`             | `{ id, contract, method, input }`                                                                           | The stream handler for `<contract> <method>` runs with the input and a sink; a stream receives no scope.                         |
| host → desktop | `event`                 | `{ kind: "event", id, values: [item] }`                                                                     | One per item a stream pushes.                                                                                                    |
| host → desktop | `end`                   | `{ kind: "end", id, error? }`                                                                               | A stream ended: refused, failed, or closed by the desktop.                                                                       |
| desktop → host | `unsubscribe`, `cancel` | `{ id }`                                                                                                    | Ends the open stream with that id and answers `end`; an unknown id is ignored.                                                   |
| —              | `disconnect`            | —                                                                                                           | The socket's open streams are forgotten without being ended: the Thread-log and catalog subscriptions they made stay registered. |

A wire error is `{ code, message }`: the thrown error's string `code`, or
`unavailable` when it has none. A `call` or `subscribe` no handler serves is
logged as `?? UNKNOWN` and refused with code `unavailable` and the message
`<contract> <method> is not served by the development fake host.`, as a
`result` for a call and as an `end` for a subscription
([`server.mjs`](server.mjs), [`contracts.mjs`](contracts.mjs)). A stream
handler that throws ends its stream with the error.

### Served contracts

The full shapes of `doric.catalog/v1` and `doric.diagnostics/v1` are in
[Composition and distribution](../../docs/architecture/bundles/composition-and-distribution.md#the-contract-doriccatalogv1)
and [Observability](../../docs/architecture/bundles/observability.md#diagnostics-doricdiagnosticsv1).
A handler reads the wire input's first item when the input is an array, and
the input itself otherwise, except `doric.catalog/v1.artifact`, which reads
`sha256` from the input itself, and `doric.catalog/v1.disable`, which logs the
whole input ([`contracts.mjs`](contracts.mjs)). An array input to `artifact`
is therefore answered `not_found`
`No generation distributes an artifact with SHA-256 undefined.`, and a missing
input throws and is answered `unavailable`. The workspace records are in
[Data](#data).

| Contract and method                    | Input                                  | Answer                                                                                                                                                                                                                                                                                                                          |
| -------------------------------------- | -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `doric.catalog/v1.distribution`        | —                                      | The current generation's distribution ([`bundles.mjs`](bundles.mjs)).                                                                                                                                                                                                                                                           |
| `doric.catalog/v1.artifact`            | `{ sha256 }`                           | `{ sha256, base64 }`: the file's bytes, re-hashed on every read. `not_found` `No generation distributes an artifact with SHA-256 <sha256>.` when the current generation has no such file; `not_found` `The artifact <sha256> is missing from <path>.` when the file is gone or its hash differs ([`bundles.mjs`](bundles.mjs)). |
| `doric.catalog/v1.disable`             | any                                    | Nothing; logs that `disable` is a no-op and that a composition without the bundle is the way to drop it.                                                                                                                                                                                                                        |
| `doric.catalog/v1.resetComposition`    | —                                      | Nothing.                                                                                                                                                                                                                                                                                                                        |
| `doric.diagnostics/v1.report`          | any                                    | Nothing; the report is discarded.                                                                                                                                                                                                                                                                                               |
| `runtime/v2.projects`                  | `{ limit?, cursor? }`                  | `{ items, nextCursor? }`; `limit` defaults to 100 and `cursor` is the decimal offset ([`workspace.mjs`](workspace.mjs)).                                                                                                                                                                                                        |
| `runtime/v2.project`                   | project id                             | The Project, or nothing.                                                                                                                                                                                                                                                                                                        |
| `runtime/v2.projectActivity`           | —                                      | `[{ project, activityAt, latestActiveThreadId }]`, highest `activityAt` rank first; `activityAt` is the Project's `updatedAt` and `latestActiveThreadId` its first Thread's id.                                                                                                                                                 |
| `runtime/v2.createProject`             | `{ name }`                             | A new Project with a random UUID, color `blue`, state `ready`.                                                                                                                                                                                                                                                                  |
| `runtime/v2.renameProject`             | `{ id, name }`                         | The renamed Project, or nothing when unknown.                                                                                                                                                                                                                                                                                   |
| `runtime/v2.setProjectColor`           | `{ id, color }`                        | The Project with the color set, or removed when `color` is `null`; nothing when unknown.                                                                                                                                                                                                                                        |
| `runtime/v2.terminateProject`          | project id                             | The Project with state `cancelled` and `finishedAt`; nothing when unknown.                                                                                                                                                                                                                                                      |
| `runtime/v2.deleteProject`             | project id                             | `"deleted"` (the Project and its Threads are removed) or `"missing"`.                                                                                                                                                                                                                                                           |
| `runtime.threads/v1.threads`           | `{ projectId, limit?, cursor? }`       | `{ items }`: the Project's Threads from the offset, `limit` defaulting to 100; never a `nextCursor`.                                                                                                                                                                                                                            |
| `runtime.threads/v1.thread`            | thread id                              | The Thread, or nothing.                                                                                                                                                                                                                                                                                                         |
| `runtime.threads/v1.createThread`      | `{ projectId, name, parentThreadId? }` | `{ status: "created", thread }`, named `Thread` when `name` is `""` and carrying `parentThreadId` when given; `{ status: "missing" }` for an unknown Project; `{ status: "invalid_parent" }` for an unknown parent. A missing `name` throws a `TypeError` ([`workspace.mjs`](workspace.mjs)) and is answered `unavailable`.     |
| `runtime.threads/v1.renameThread`      | `{ id, name }`                         | The renamed Thread, or nothing when unknown.                                                                                                                                                                                                                                                                                    |
| `runtime.threads/v1.terminateThread`   | thread id                              | The Thread with state `cancelled` and `finishedAt`; nothing when unknown.                                                                                                                                                                                                                                                       |
| `runtime.threads/v1.deleteThread`      | thread id                              | `"deleted"` or `"missing"`; the Thread's log stays in memory.                                                                                                                                                                                                                                                                   |
| `runtime.threads/v1.prompt`            | `{ id, prompt }`                       | `{ status: "accepted", promptId }`; see [Sending a prompt](#sending-a-prompt). `{ status: "missing" }` for an unknown Thread; `invalid_input` `A non-empty prompt is required.` for a prompt that is empty after trimming.                                                                                                      |
| `comments/v1.add`, `.list`, `.resolve` | see [Comments](#comments)              |                                                                                                                                                                                                                                                                                                                                 |

| Stream                           | Input                          | Items                                                                                                                                                                                                                                                                                                                                             |
| -------------------------------- | ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `doric.catalog/v1.watch`         | —                              | `{ generation }` after each reload; nothing at subscription ([`main.mjs`](main.mjs)).                                                                                                                                                                                                                                                             |
| `runtime/v2.watchProject`        | `{ projectId }`                | One `{ kind: "snapshot", projectId, project (or null), threads }`, then nothing.                                                                                                                                                                                                                                                                  |
| `runtime.threads/v1.watchThread` | `{ threadId, afterSequence? }` | First `{ kind: "snapshot", threadId, projectId, project, thread, events }` (`null` for what is unknown), where `events` are the log rows with a sequence above `afterSequence` (default 0, the whole log); then `{ kind: "event", event: row }` for each row appended to that Thread, until the stream ends ([`thread-log.mjs`](thread-log.mjs)). |
| `terminal/v1.watchProject`       | project id                     | One `{ kind: "snapshot", projectId, terminals: [] }`: the fake host runs no sandbox.                                                                                                                                                                                                                                                              |

Every other contract or method, among them `doric.catalog/v1.get`,
`settings/v1` and `files/v1`, is refused as unknown: the fake host activates
no host parts.

### Sending a prompt

`runtime.threads/v1.prompt` runs no agent. It appends three rows to the
Thread's log under a new random prompt id — `prompt.accepted`
`{ type, text, source: { kind: "user" }, queued: false }`, `prompt.started`
`{ type }` and `prompt.finished`
`{ type, status: "completed", text: "", source: { kind: "user" } }` — and logs
that the turn completed with no answer text ([`contracts.mjs`](contracts.mjs)).
The new prompt id becomes the Thread's current prompt
([`thread-log.mjs`](thread-log.mjs)).

### Comments

Every `comments/v1` call needs a `projectId` in its scope; without one it is
refused with `invalid_input`
`The call needs a projectId in its scope: the Project lease is scoped by it.`
Nothing falls back to the seeded Project ([`contracts.mjs`](contracts.mjs)).
The registry stores what it is given and never interprets the target
([`comments.mjs`](comments.mjs)).

- `add({ target, text, author? })`: refuses with `invalid_input`
  `A comment needs a target.` when `target.id` is not a string, and
  `A comment needs non-empty text.` when `text` is empty after trimming. It
  stores `{ commentId (random UUID), target, text, resolved: false, createdAt, author? }`,
  then appends `comments.added/v1`
  `{ type, commentId, target, text, author? }` to the log of the scope's
  Thread and answers the comment. Without a `threadId` in the scope the
  append is refused with `invalid_input`
  `The call needs a threadId in its scope: its event belongs to a Thread log.`;
  the comment is already stored and is listed.
- `list({ target?, kind? })`: every stored comment, of every Project, in
  insertion order, whose target has that `kind` and names the same target:
  same `kind` and `id`, and the same `revision` when both have one. Without
  `target`, every comment of the kind, or every comment.
- `resolve({ commentId, resolved? })`: nothing for an unknown id. `resolved`
  defaults to `true`. When it changes the comment's state, the state is set,
  then `comments.resolved/v1` `{ type, commentId, resolved }` is appended
  under the same scope rule as `add`; an unchanged state appends nothing. It
  answers the comment.

A comment event's prompt id is the scope's `promptId`, else the Thread's
current prompt, so the event sits in the conversation beside the turn it
comments on ([`comments.mjs`](comments.mjs)).

## Data

Everything lives in memory and is lost when the process exits; the only file
the fake host writes is the staged copy under `tmp/fake-host/bundles`
([`bundles.mjs`](bundles.mjs)).

### Workspace

Two Projects with one Thread each, from fixed ids, created at boot
([`workspace.mjs`](workspace.mjs)):

| Project   | Project id                             | Color    | Thread | Thread id                              |
| --------- | -------------------------------------- | -------- | ------ | -------------------------------------- |
| `Doric`   | `11111111-1111-4111-8111-111111111111` | `violet` | `Main` | `aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa` |
| `Sandbox` | `22222222-2222-4222-8222-222222222222` | `teal`   | `Main` | `bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb` |

- A Project is `{ id, name, color?, state: "ready", configRevision: 1, createdAt, updatedAt, activityAt, finishedAt? }`.
- A Thread is `{ id, projectId, name, state: "ready", lastSequence: 0, cwd: "/workspace/<lower-case name>", createdAt, updatedAt, activityAt, parentThreadId?, finishedAt? }`.
- Seeded and created records carry `createdAt` and `updatedAt`
  `2024-01-01T00:00:00.000Z`; a mutation, or a row appended to a Thread's
  log, sets `updatedAt` to the current time, so seeding leaves the `Doric`
  Thread's `updatedAt` at the boot time ([`thread-log.mjs`](thread-log.mjs)).
- `activityAt` is a rank (2 for the seeded `Doric` records, 1 for the
  `Sandbox` ones, the record count plus 10 for a created one). The Projects'
  rank orders `projectActivity`; the Threads' rank is used nowhere.

### Thread log

One list of rows per Thread ([`thread-log.mjs`](thread-log.mjs)):

```text
{ projectId, threadId, promptId, sequence, type, event, createdAt }
```

`sequence` counts from 1 per Thread; `event` is the payload with its `type`.
Appending a row sets the Thread's `lastSequence` and `updatedAt`, records the
row's `promptId` as the Thread's current prompt, and pushes the row to every
open `watchThread` of that Thread. A push that throws is logged
`a watch of Thread <id> refused event <sequence>: <message>`, and the row
stays. A row for an unknown Thread is still kept.

### Seeded conversation

At boot the `Doric` Thread receives five rows under the prompt id
`00000000-0000-4000-8000-000000000001`, which becomes its current prompt, and
the fake host logs `seeded 5 events on Thread …` ([`seed.mjs`](seed.mjs)):

1. `prompt.accepted` `{ text: "Mostre o checkout com o botão de pagar.", source: { kind: "user" }, queued: false }`
2. `prompt.started`
3. `agent.started`
4. `text.delta` `{ delta: "O checkout tem o botão de pagar abaixo do resumo do pedido." }`
5. `prompt.finished` `{ status: "completed", text: <the same paragraph>, source: { kind: "user" } }`

## Limits

- One process, one workspace; no authentication and no CORS configuration
  ([`server.mjs`](server.mjs)).
- Pages hold 100 records by default; Thread pages carry no cursor
  ([`workspace.mjs`](workspace.mjs)).
- An artifact is served only from the current generation's files
  ([`bundles.mjs`](bundles.mjs)).
- The bundles root is resolved once, at boot; `GET /reload` never stages
  bundles again ([`main.mjs`](main.mjs)).
- Streams receive no call scope, and a `doric.catalog/v1.watch` subscriber
  stays registered for the life of the process and keeps receiving
  `{ generation }` events under its id after it ends
  ([`server.mjs`](server.mjs), [`contracts.mjs`](contracts.mjs)).
- Deleting a Project or Thread leaves its log rows and comments in memory
  ([`workspace.mjs`](workspace.mjs)).

## Test

```sh
npm run test:fake-host
```

It runs [`tests/fake-host-bundles.test.mjs`](../../tests/fake-host-bundles.test.mjs)
with `node --test`. The test builds a temporary folder with two hand-written
bundles under `bundles/<group>/<id>` and a `node_modules` directory without a
manifest, and checks that, with no `dist/bundles`, the staging fallback stages
both bundles into that folder's `tmp/fake-host/bundles` and skips the other
directory; it does not touch the repository's bundles. It imports `bundle`
through [`bundles.mjs`](bundles.mjs), so run `npx nx run bundle:build` first.
