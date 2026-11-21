# Doric

**A self-hosted desktop workspace where AI agents build software in a sandbox
of their own, and you stay in control of every step.**

Give an agent a task and Doric hands it a real development environment: files,
Git, a terminal, the web, and a screen it can run apps on. The agent works in
that sandbox, not on your laptop. A larger task can be split across a team of
agents that you can inspect, steer and stop at any time. You run the backend
and choose the model provider; code, conversations and keys stay on
infrastructure you control.

Doric has three applications and a set of bundles. The **host**
([`app/backend/doric-host`](app/backend/doric-host/README.md)) is a Node.js
server: one HTTP listener carries its REST routes and Socket.IO namespaces
([`src/index.ts`](app/backend/doric-host/src/index.ts)), and the `runtime`
bundle queues and runs each Thread's prompts
([`runner.ts`](bundles/runtime/runtime/src/host/domain/runner.ts)) through the
agent loop of the `default` bundle
([`executor.ts`](bundles/runtime/default/src/host/executor.ts)). The
**desktop app** ([`app/desktop/doric`](app/desktop/doric/README.md)), an
Electron app, is where you create Projects, talk to agents and review their
work; every window it opens loads the page the **renderer shell**
([`app/desktop/doric-renderer`](app/desktop/doric-renderer/README.md))
builds. Almost everything they do comes from **bundles** under `bundles/`:
tools, skills, model providers, sandboxes, storage and every part of the
desktop UI.

> **No authentication.** The host has no login and no access control: anyone
> who reaches its port can read every Project, change the settings and run
> work ([`app.ts`](bundles/foundation/transport/src/host/app.ts)). The Compose
> host of the [quick start](#quick-start) binds `0.0.0.0` on the host network,
> so the API is on every interface of the machine, and `.env` cannot change
> that ([`compose.yaml`](app/backend/doric-host/compose.yaml)). Run it locally
> or on an isolated, trusted network, and never expose it to the internet.

## What you can do

- **Organize work into Projects and Threads.** A Project owns one sandbox and
  its files; a Thread is a conversation with its own history and prompt queue.
  Threads of one Project share its files and can run at the same time
  ([`model.ts`](bundles/runtime/runtime/src/contracts/model.ts),
  [Projects and Threads](docs/features/projects-and-threads.md)).
- **Let an agent run a team.** An agent creates child Threads, hands each a
  self-contained task, sends follow-ups, reads results and closes finished
  work; every child is a conversation you can open and take over
  ([`thread-spawn.ts`](bundles/features/threads/src/host/tools/thread-spawn.ts),
  [`threads`](bundles/features/threads/README.md),
  [Delegation](docs/features/delegation.md)).
- **Give agents real tools.** Agents find, read, edit and write files
  ([`edit.ts`](bundles/features/files/src/host/tools/edit.ts)), run commands
  ([`tool.ts`](bundles/features/terminal/src/host/tool.ts)), use Git
  ([`git.ts`](bundles/features/git/src/host/tools/git.ts)) and research the
  web ([`web.ts`](bundles/features/web/src/host/tools/web.ts)) inside the
  sandbox ([Files](docs/features/files.md), [Terminal](docs/features/terminal.md),
  [Git](docs/features/git.md), [Web research](docs/features/web-research.md)).
  Each sandbox image ships Node.js, Git, `gh`, the Docker CLI and Xvfb
  ([`.sandbox.Dockerfile`](app/backend/doric-host/.sandbox.Dockerfile)).
- **See what happens.** Browse a Project's files
  ([`files-tree.tsx`](bundles/features/files/src/client/tree/files-tree.tsx)),
  review Git changes
  ([`git-changes.tsx`](bundles/features/git/src/client/changes/git-changes.tsx)),
  follow the agent's terminals or open your own
  ([`terminal-view.tsx`](bundles/features/terminal/src/client/view/terminal-view.tsx)),
  and watch graphical apps on the sandbox's screen
  ([`elements.tsx`](bundles/features/screen/src/client/elements.tsx),
  [Screen](docs/features/screen.md)).
- **Review UI on a live canvas.** With Papercraft, the agent answers with a
  `papercraft` fence that the conversation draws as a live preview built from
  your Project's own components, Storybook stories and Tailwind v4 theme. You
  pin a comment on the exact element you mean, and the agent replies in the
  comment's thread and writes a revision
  ([`fence.tsx`](bundles/features/papercraft/src/client/fence.tsx),
  [`papercraft`](bundles/features/papercraft/README.md),
  [Papercraft](docs/features/papercraft.md), [Comments](docs/features/comments.md)).
- **Get answers as UI.** Forms, tables, charts, diagrams and question forms
  drawn from `openui-lang` fences; a click or an answer goes back to the agent
  as your next message
  ([`fence-element.tsx`](bundles/features/openui/src/client/fence-element.tsx),
  [`ask.tsx`](bundles/features/openui/src/client/question/ask.tsx),
  [`openui`](bundles/features/openui/README.md),
  [Generative UI](docs/features/generative-ui.md)).
- **Control execution.** Queue prompts, edit or remove them before they run,
  steer a running prompt, stop it, and pause and resume the queue
  ([`runner.ts`](bundles/runtime/runtime/src/host/domain/runner.ts),
  [Stop, steering and the queue of inputs](docs/features/prompt-control.md)).
  The desktop shows a native notice when a prompt finishes outside your view;
  on macOS only a code-signed build can show it
  ([`notifications.ts`](app/desktop/doric/src/platform/native/notifications.ts)).
- **Choose your models.** OpenRouter
  ([`kind.ts`](bundles/providers/openrouter/src/host/kind.ts)), an OpenAI
  Responses endpoint ([`kind.ts`](bundles/providers/openai/src/host/kind.ts))
  and a Claude Code subscription login
  ([`kind.ts`](bundles/providers/claude/src/host/kind.ts)) are provider kinds;
  the conversation's execution picker sets a Thread's own provider, model and
  reasoning effort
  ([`execution-picker.tsx`](bundles/desktop/chat/src/client/components/organisms/execution-picker.tsx),
  [Models and providers](docs/features/models-and-providers.md),
  [Per-thread model](docs/features/per-thread-model.md)).
- **Watch cost.** The conversation footer shows the context the selected
  Thread uses and the cost of the Thread and its descendants
  ([`cost-breakdown.tsx`](bundles/features/usage/src/client/components/cost-breakdown.tsx),
  [`usage`](bundles/features/usage/README.md), [Usage](docs/features/usage.md)).
- **Keep your history.** PostgreSQL keeps every conversation, setting and
  credential ([`postgres.ts`](bundles/foundation/postgres/src/host/postgres.ts)),
  with secrets encrypted with AES-256-GCM under `DORIC_CREDENTIAL_KEY`
  ([`envelope.ts`](bundles/foundation/postgres/src/host/secrets/envelope.ts),
  [Credentials](docs/features/credentials.md)); a Docker volume per Project
  keeps its workspace across host restarts
  ([`workspace.ts`](packages/docker-sandbox/src/lib/workspace.ts),
  [`docker`](bundles/sandboxes/docker/README.md)).
- **Integrate.** Other clients drive Projects, Threads and execution events
  through the host's REST routes
  ([`app.ts`](bundles/foundation/transport/src/host/app.ts)) and Socket.IO
  namespaces
  ([`workspace.ts`](bundles/foundation/transport/src/host/sockets/workspace.ts);
  [Host API](docs/features/host-api.md), the
  [reference](app/backend/doric-host/README.md#rest-api)).

## How it works

```text
┌──────────────────┐   REST + Socket.IO   ┌──────────────────────────┐
│ Desktop app      │ ───────────────────▶ │ Doric host               │
│ (Electron)       │                      │ bundles + agent runtime  │
└──────────────────┘                      └──┬──────────┬─────────┬──┘
                                             │          │         │
                                     ┌───────▼──┐  ┌────▼─────┐ ┌─▼──────────┐
                                     │PostgreSQL│  │ Project  │ │ Model      │
                                     │ history, │  │ sandboxes│ │ provider   │
                                     │ settings │  │ (Docker) │ │ (your key) │
                                     └──────────┘  └──────────┘ └────────────┘
```

- The **host** listens on `DORIC_HOST:DORIC_PORT`, `0.0.0.0:3000` by default,
  loads the bundles its composition enables, and logs `Doric listening` once
  it accepts requests ([`src/index.ts`](app/backend/doric-host/src/index.ts)).
  Startup never applies database migrations; the `migrate` target does
  ([`project.json`](app/backend/doric-host/project.json)).
- The **composition**
  ([`composition.json`](app/backend/doric-host/composition.json)) lists the
  enabled bundles, the bundle that provides each storage contract, and the
  sandbox alternative, `alternatives.sandbox`: `DORIC_SANDBOX_PROVIDER` picks
  `docker`, the default, or `firecracker`; the host applies the choice at boot
  ([`boot.ts`](app/backend/doric-host/src/lib/bundles/boot.ts)).
- The **desktop app** connects to `DORIC_HOST_URL`, or `http://127.0.0.1:3000`
  when unset ([`main.ts`](app/desktop/doric/src/main.ts),
  [`host-bridge.ts`](app/desktop/doric/src/platform/bridge/host-bridge.ts)). It
  downloads the desktop parts of the bundles from the host and draws every
  window with them; the shell page it loads holds no product UI
  ([`doric-renderer`](app/desktop/doric-renderer/README.md)).
- How bundles are declared, built, distributed and activated is in the
  [architecture overview](docs/architecture/bundles.md) and the
  [`bundle` package](packages/bundle/README.md).

## Quick start

This guide runs the host and the desktop app on one computer. You need:

- Git, **Node.js 22** and **npm 11.13.0**, the versions CI and the host image
  use ([`ci.yml`](.github/workflows/ci.yml),
  [`.Dockerfile`](app/backend/doric-host/.Dockerfile)). Install npm with
  `npm install --global npm@11.13.0`: npm 10 refuses `npm ci` on this lockfile.
- Docker with Docker Compose v2, running and reachable by your user.
- A model provider key; the steps below use OpenRouter.

The Compose backend needs **Linux**: its host services use the host network,
and the Docker one sets up its egress rules with `nftables`
([`compose.yaml`](app/backend/doric-host/compose.yaml),
[`host.ts`](packages/docker-sandbox/src/lib/host.ts)). On **macOS**, run the
host natively with Docker Desktop (step 2). Run every command from the
repository root in a POSIX shell.

### 1. Prepare the checkout

```sh
npm ci
cp app/backend/doric-host/.env.example app/backend/doric-host/.env
openssl rand -hex 24
openssl rand -base64 32
```

In `app/backend/doric-host/.env`, set `DORIC_POSTGRES_PASSWORD` to the first
value and `DORIC_CREDENTIAL_KEY` to the second, and keep `doric` as the user
and database ([`.env.example`](app/backend/doric-host/.env.example)). Git
ignores the file. Keep the credential key: the host cannot decrypt a stored
secret without it, and refuses to start when a stored credential holds a
secret and the key is missing
([`backend.ts`](bundles/foundation/postgres/src/host/secrets/backend.ts),
[Credentials](docs/features/credentials.md)).

The same file sets `DORIC_SANDBOX_DOCKER_SOCKET=true`: every Project sandbox
then gets the host's Docker socket, and with it the Docker daemon's authority
over this machine. Set it to `false` where the Projects are not yours
([`.env.example`](app/backend/doric-host/.env.example),
[`sandbox.ts`](bundles/sandboxes/docker/src/host/sandbox.ts)).

Build the sandbox image every Project runs in:

```sh
docker build -f app/backend/doric-host/.sandbox.Dockerfile -t doric-sandbox:local app/backend/doric-host
```

### 2. Start the host

**Linux, with Docker Compose:**

```sh
docker compose --env-file app/backend/doric-host/.env -f app/backend/doric-host/compose.yaml --profile docker up -d --build
docker compose --env-file app/backend/doric-host/.env -f app/backend/doric-host/compose.yaml logs -f docker
```

Compose starts PostgreSQL, runs the one-shot `migrate` service, and then
starts the `docker` service, the host
([`compose.yaml`](app/backend/doric-host/compose.yaml)). Wait for
`Doric listening`, then press Ctrl+C to leave the log; the services keep
running. The first build takes several minutes.

The `docker` service sets `DORIC_HOST: 0.0.0.0` and uses the host network, so
the unauthenticated API listens on port 3000 of every interface of this
machine; no `.env` value changes that
([`compose.yaml`](app/backend/doric-host/compose.yaml)). Keep the machine on
a trusted network, or block the port at its firewall.

These commands use the Compose project name of the file, `doric-sandbox`.
`npm run doric:docker:build` runs the same `up --build` under the project name
`doric` ([`package.json`](package.json)); the project name prefixes the
volumes, so the two keep separate databases. Use one of them consistently,
and pass `-p doric` to `logs` and `down` when you use the script.

<details>
<summary>macOS: run the host natively with Docker Desktop</summary>

Start only PostgreSQL, load the values of the file you edited, and run the
host:

```sh
docker compose --env-file app/backend/doric-host/.env -f app/backend/doric-host/compose.yaml up -d --wait postgres
set -a
. ./app/backend/doric-host/.env
set +a
export DORIC_DATABASE_URL="postgresql://${DORIC_POSTGRES_USER}:${DORIC_POSTGRES_PASSWORD}@127.0.0.1:${DORIC_POSTGRES_PORT:-5432}/${DORIC_POSTGRES_DB}"
export DORIC_HOST=127.0.0.1
export DORIC_SANDBOX_IMAGE=doric-sandbox:local
export DORIC_SANDBOX_SSH=false
npx nx run doric-host:migrate
npx nx serve doric-host
```

Keep this terminal open, and load the variables again in every new shell that
starts the host. The Docker provider reads `DORIC_SANDBOX_IMAGE` (default
`node:22-bookworm`), `DORIC_SANDBOX_SSH` and `DORIC_SANDBOX_DOCKER_SOCKET`,
which `.env` sets to `true` so a sandbox can build images
([`sandbox.ts`](bundles/sandboxes/docker/src/host/sandbox.ts)). With
`DORIC_SANDBOX_SSH=true` the provider also needs a static Dropbear binary
that only the host image ships
([host README](app/backend/doric-host/README.md#natively)). The native host
measures free space in the current directory unless `DORIC_STORAGE_PATH`
names another path, so watch Docker Desktop's own disk space as well
([`health.ts`](bundles/foundation/postgres/src/host/storage/health.ts)).

</details>

In another terminal, check that the API answers
([`projects.ts`](bundles/foundation/transport/src/host/routes/projects.ts)):

```sh
curl --fail http://127.0.0.1:3000/projects
```

### 3. Open the desktop app

In another terminal:

```sh
npm run doric:dev
```

The script builds the desktop's generation runner, serves the renderer on
port 4200, and starts Electron once that port answers; when either process
exits, the other stops ([`package.json`](package.json),
[`webpack.config.js`](app/desktop/doric-renderer/webpack.config.js),
[`serve.mjs`](app/desktop/doric/serve.mjs)). Electron starts with
`--no-sandbox` when run as root or when `DORIC_ELECTRON_NO_SANDBOX=1` is set
([`serve.mjs`](app/desktop/doric/serve.mjs)). Wait until the connection badge reads **Connected**
([`connection-badge.tsx`](bundles/features/resources/src/client/monitor/connection-badge.tsx)).

### 4. Connect a model

A new database already holds an `openrouter` provider, an empty `API_TOKEN`
credential named `OPENROUTER_API_KEY` that it authenticates with, and the
execution default `deepseek/deepseek-v4-flash-0731` at effort `low`, with 32
turns per prompt ([`postgres` README](bundles/foundation/postgres/README.md#rows-the-migrations-leave)).
Open **Settings** from the account menu's **Settings** entry or the
dashboard's **All settings**
([`index.ts`](bundles/desktop/settings/src/client/index.ts)); its sections are
listed in [`sections.ts`](bundles/desktop/settings/src/client/domain/sections.ts):

1. In **Credentials**, give `OPENROUTER_API_KEY` your OpenRouter key.
2. In **Execution**, keep or change the provider, a model that supports tool
   calls, its reasoning effort and the turn limit of one prompt.
3. Each change saves on its own after a short pause, and a toast reports the
   save the host accepted or refused; wait for it before you send a prompt
   ([`use-config-autosave.ts`](bundles/desktop/settings/src/client/hooks/use-config-autosave.ts),
   [Settings](docs/features/settings.md)).

A provider authenticates with the `API_TOKEN` credential its `token` field
names ([`kind.ts`](bundles/providers/openrouter/src/host/kind.ts),
[Credentials](docs/features/credentials.md)). For commits and
private GitHub repositories, add your Git identity and a GitHub token under
**Credentials** and choose them in **Versioning**
([`git`](bundles/features/git/README.md)).

### 5. Start a task

Create a **Project** in the sidebar and a **Thread** in it, wait for its
sandbox to be ready, and send a prompt:

> Create a small Node.js app in /workspace/hello with a README explaining how
> to run it. Run it and show me the result.

The Files and Changes panels show the work. Your local checkout is not mounted
into a Project: ask the agent to clone a repository into `/workspace`. Then
try a team, or a UI preview:

> Clone https://github.com/<you>/<repo> into /workspace. Split the open TODOs
> between child threads, have each one fix and test its part, and summarize
> what changed.

> Show me a preview of a new empty state for the projects list before you
> implement it.

On a preview, click an element, leave a comment, and send it with
Cmd/Ctrl+Enter ([Papercraft](docs/features/papercraft.md)).

### Stop the host

```sh
docker compose --env-file app/backend/doric-host/.env -f app/backend/doric-host/compose.yaml --profile docker down
```

`down` keeps every volume. `down -v` deletes the volumes Compose declares,
`postgres-data` (the database), `firecracker-state` and `firecracker-cache`
([`compose.yaml`](app/backend/doric-host/compose.yaml)), and keeps the Project
workspaces: the Docker provider creates each as its own volume,
`doric-workspace-<project id>`, labelled `doric.sandbox.workspace`
([`workspace.ts`](packages/docker-sandbox/src/lib/workspace.ts)). To delete
those too, once the host is stopped (Docker refuses to remove a volume that
a sandbox container still uses):

```sh
docker volume ls -q --filter label=doric.sandbox.workspace | xargs -r docker volume rm
```

On macOS, stop the native host with Ctrl+C and PostgreSQL with the same
`down` command.

## Things to know

- **Agent actions have real effects.** Threads of a Project share its
  workspace. Stopping or pausing a prompt does not undo the file changes,
  commands or remote Git operations already made: a stop aborts the run and
  reverts nothing
  ([`runner.ts`](bundles/runtime/runtime/src/host/domain/runner.ts),
  [Stop, steering and the queue of inputs](docs/features/prompt-control.md)).
- **Low storage pauses execution.** Before each prompt and every three seconds
  of a run, the runtime asks the storage backend for its free space with
  `storage/v1.health()`
  ([`storage-pressure.ts`](bundles/runtime/runtime/src/host/domain/storage-pressure.ts));
  the `postgres` backend measures the filesystem of `DORIC_STORAGE_PATH`, or of
  the current directory when it is unset
  ([`health.ts`](bundles/foundation/postgres/src/host/storage/health.ts)). At
  10% free blocks or less, or when the path cannot be measured, the run stops
  and the Thread's queue pauses with `storage_low` until you free space and
  resume it
  ([`storage-pause.ts`](bundles/runtime/runtime/src/host/domain/storage-pause.ts)).
- **Sandboxes hold capacity.** A Project keeps its sandbox until it is
  terminated, and deleting it removes its Docker workspace volume
  ([`workspace.ts`](packages/docker-sandbox/src/lib/workspace.ts),
  [`docker`](bundles/sandboxes/docker/README.md)). A Firecracker sandbox keeps
  no workspace when it is recreated
  ([`firecracker`](bundles/sandboxes/firecracker/README.md)).
- **Isolation depends on the machine.** On Linux the Docker provider applies
  its own `nftables` egress rules; on macOS and Windows it relies on Docker
  Desktop's networking instead
  ([`host.ts`](packages/docker-sandbox/src/lib/host.ts)). A sandbox given the
  Docker socket (`DORIC_SANDBOX_DOCKER_SOCKET=true`) holds the Docker daemon's
  authority over the machine. Compose defaults it to `false`, and the `.env`
  of the [quick start](#1-prepare-the-checkout) turns it on
  ([`compose.yaml`](app/backend/doric-host/compose.yaml),
  [`.env.example`](app/backend/doric-host/.env.example)).
- **Model calls cost money.** Every prompt calls your provider with your key.

## Develop

Doric is an Nx and npm-workspaces monorepo in TypeScript
([`nx.json`](nx.json), [`package.json`](package.json)). The workspaces are:

| Folder             | What it holds                                                                                                                                                                                                                      |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `app/backend/`     | The host, [`doric-host`](app/backend/doric-host/README.md), and its end-to-end suite `doric-host-e2e`                                                                                                                              |
| `app/desktop/`     | The Electron app [`doric`](app/desktop/doric/README.md) (Nx project `doric-app`), the shell [`doric-renderer`](app/desktop/doric-renderer/README.md), the platform build `doric-platform` and the end-to-end suite `doric-app-e2e` |
| `bundles/<group>/` | The 33 bundles, each with a `manifest.json`, a README and an `AGENTS.md`; their map is [Bundles](#bundles)                                                                                                                         |
| `packages/`        | Libraries the host, the app and the bundles build on; see [Packages](#packages)                                                                                                                                                    |
| `tools/`           | [`tool-okf`](tools/okf/README.md), the `okf_search` agent tool                                                                                                                                                                     |
| `scripts/`         | Command-line scripts, among them the [fake host](scripts/fake-host/README.md)                                                                                                                                                      |
| `tests/`           | The repository checks run by `npm run lint:test` and `npm run test:fake-host`                                                                                                                                                      |

Use `npx nx show projects` to list the projects and
`npx nx show project <project>` to see a project's targets, including those
the `@nx/js/typescript` and `@nx/webpack` plugins infer
([`nx.json`](nx.json)).

### Scripts of the root

Each runs from the repository root as `npm run <script>`
([`package.json`](package.json)).

| Script                   | What it runs                                                                                                                                                                                                                                                                                                   |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `doric:dev`              | The desktop app in development, as in [step 3](#3-open-the-desktop-app)                                                                                                                                                                                                                                        |
| `doric:docker:build`     | `docker compose -p doric … --profile docker up -d --build`, the Compose host under the project name `doric`                                                                                                                                                                                                    |
| `doric:fake-host`        | The development [fake host](#develop-bundles-without-the-host)                                                                                                                                                                                                                                                 |
| `doric:spawn-agent`      | `-- --prompt <text> [--url <url>] [--terminate]`: creates a Project and its root Thread on a running host (`DORIC_URL` or `http://127.0.0.1:3000`), sends the prompt and prints the events until it finishes ([`spawn-agent.mjs`](scripts/spawn-agent.mjs))                                                    |
| `okf`                    | `-- <model-id>`: writes the Open Knowledge Format bundle of this repository under `.agents/bundles`, with the OpenAI-compatible endpoint `OKF_BASE_URL` (default `http://localhost:1234/v1`) and the key `OKF_API_KEY` ([`okf.mjs`](scripts/okf.mjs), [Knowledge bundles](docs/features/knowledge-bundles.md)) |
| `claude:oauth`           | A Claude Code OAuth sign-in in the browser (`-- --no-browser` to paste the code), written as an authorization header to the root `.env` ([`claude-oauth.mjs`](scripts/claude-oauth.mjs), [Provider sign-in](docs/features/provider-sign-in.md))                                                                |
| `codex:oauth`            | The same for Codex ([`codex-oauth.mjs`](scripts/codex-oauth.mjs))                                                                                                                                                                                                                                              |
| `lint`, `lint:fix`       | Biome's linter over the repository, checking or fixing ([`biome.json`](biome.json))                                                                                                                                                                                                                            |
| `format`, `format:check` | Biome's formatter, then Prettier, writing or checking                                                                                                                                                                                                                                                          |
| `lint:test`              | The tests of the Biome configuration and of the bundle boundaries ([`lint.test.mjs`](tests/lint.test.mjs), [`boundaries.test.mjs`](tests/boundaries.test.mjs), [Boundaries](docs/architecture/bundles/boundaries.md))                                                                                          |
| `test:fake-host`         | The test of the fake host's bundle staging ([`fake-host-bundles.test.mjs`](tests/fake-host-bundles.test.mjs))                                                                                                                                                                                                  |

### Build and test

```sh
npx nx run doric-host:build           # the host, after every bundle it stages
npx nx run doric-app:build            # the desktop app
npx nx run bundle-<name>:test         # one bundle, for example bundle-chat
npx nx test <package>                 # one package, for example agent
```

Every bundle has the targets `build`, `typecheck` and `test`, under the Nx name
`bundle-<directory>` ([`bundles/desktop/chat/project.json`](bundles/desktop/chat/project.json)).
CI runs these checks, in this order, on Node.js 22 with npm 11.13.0 and a
PostgreSQL service ([`ci.yml`](.github/workflows/ci.yml)):

```sh
npx nx sync:check
npm run lint:test
npm run format:check
npm run lint
DORIC_DATABASE_URL=postgresql://doric:doric@127.0.0.1:5432/doric npx nx run doric-host:migrate
DORIC_TEST_DATABASE_URL=postgresql://doric:doric@127.0.0.1:5432/doric npx nx test doric-host
DORIC_TEST_DATABASE_URL=postgresql://doric:doric@127.0.0.1:5432/doric npx nx run-many -t test --projects=tag:type:bundle
npx nx run-many -t test -p bundle,desktop,doric-platform,doric-app
npm run test:fake-host
npx nx test agent
npx nx run-many -t build typecheck
```

Tests that need a database skip without `DORIC_TEST_DATABASE_URL`; those that
start a sandbox run only with `DORIC_TEST_SANDBOX=true`
([host README](app/backend/doric-host/README.md#validation)). Rules for
changing the code, and the checks to run before a change is complete, are in
[`AGENTS.md`](AGENTS.md) and the `AGENTS.md` of each folder.

### Develop bundles without the host

`npm run doric:fake-host` starts a development stand-in for the host on
`127.0.0.1:3000`, the address the desktop uses by default
([`main.mjs`](scripts/fake-host/main.mjs)). It serves the staged bundles of
`app/backend/doric-host/dist/bundles`, staging the built bundles itself when
that directory is absent, and answers from an in-memory workspace: no
PostgreSQL, no sandbox and no model provider
([`bundles.mjs`](scripts/fake-host/bundles.mjs)). A call it does not serve is
refused with `unavailable` and logged as `?? UNKNOWN <contract> <method>`
([`contracts.mjs`](scripts/fake-host/contracts.mjs),
[`log.mjs`](scripts/fake-host/log.mjs)). After a bundle rebuild,
`GET /reload` republishes the catalog.

```sh
npm run doric:fake-host   # one terminal
npm run doric:dev         # another
```

Its options and the contracts it answers are in the
[fake host README](scripts/fake-host/README.md).

## Documentation

- **Features** describe what a capability does across the bundles that
  implement it, under [`docs/features/`](#features).
- **Architecture** describes the mechanisms every bundle follows: manifests,
  contracts, hooks, windows, storage, distribution. Start at
  [Doric's architecture](docs/architecture/bundles.md), which indexes the
  living architecture documents; [the bundle map](docs/architecture/bundles/feature-split.md)
  maps each bundle to its function and its feature docs.
- **READMEs** describe one unit each: its interface, behavior, configuration,
  and how to build and test it.
- **`AGENTS.md` files** hold the rules for changing the code of their folder,
  starting at the root [`AGENTS.md`](AGENTS.md).

### Features

| Feature                                                                   | What it covers                                                                        |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| [Projects and Threads](docs/features/projects-and-threads.md)             | The life of a Project and of a Thread: states, the queue, leases, recovery at startup |
| [Conversation](docs/features/conversation.md)                             | The transcript, the composer, the trail, the lifecycle markers, the footer            |
| [Stop, steering and the queue of inputs](docs/features/prompt-control.md) | Stopping a prompt, steering it, and the queue of inputs                               |
| [Delegation](docs/features/delegation.md)                                 | Child Threads and the tools that create and steer them                                |
| [Default agent](docs/features/default-agent.md)                           | The executor: system prompt, tool set, model resolution, provider history             |
| [Skills](docs/features/skills.md)                                         | The skill catalog, `load_skill` and the skill sources                                 |
| [Coding workflow](docs/features/coding-workflow.md)                       | The coding workflow, a skill loaded on demand                                         |
| [Context compaction](docs/features/context-compaction.md)                 | Compaction of a Thread's context                                                      |
| [Attachments](docs/features/attachments.md)                               | Images sent to the model as attachments                                               |
| [Models and providers](docs/features/models-and-providers.md)             | Provider kinds, model catalogs, the configured providers and the default execution    |
| [Per-thread model](docs/features/per-thread-model.md)                     | A Thread's own provider, model and effort                                             |
| [Provider sign-in](docs/features/provider-sign-in.md)                     | The Claude Code sign-in and the Claude and Codex OAuth profiles                       |
| [Credentials](docs/features/credentials.md)                               | Named credentials and the secret store                                                |
| [Settings](docs/features/settings.md)                                     | The settings window: its sections, autosave and search                                |
| [Files](docs/features/files.md)                                           | The file tools, the Files panel, the file tabs and the viewer                         |
| [cwd tool](docs/features/cwd-tool.md)                                     | A Thread's working directory and the `cwd` tool                                       |
| [Git](docs/features/git.md)                                               | Branches, the Changes view, comparisons, the `git` tool                               |
| [Terminal](docs/features/terminal.md)                                     | Tracked commands and manual terminal sessions                                         |
| [Screen](docs/features/screen.md)                                         | The screen of a Project's sandbox, and its relay                                      |
| [Web research](docs/features/web-research.md)                             | The web tool                                                                          |
| [MCP servers](docs/features/mcp.md)                                       | MCP servers per Project: their tools and their OAuth sign-in                          |
| [Sandboxes](docs/features/sandboxes.md)                                   | One sandbox per Project: Docker, Firecracker and the pool                             |
| [Generative UI](docs/features/generative-ui.md)                           | UI the agent writes in its answer, and the question form                              |
| [Diagrams in OpenUI fences](docs/features/openui-diagrams.md)             | The diagram components                                                                |
| [Papercraft](docs/features/papercraft.md)                                 | Live previews of a Project's code and the canvas window                               |
| [Comments](docs/features/comments.md)                                     | Anchored comments and their attended state                                            |
| [Usage](docs/features/usage.md)                                           | A Thread's usage, cost and context capacity                                           |
| [Resource monitor](docs/features/resource-monitor.md)                     | The monitor of the host machine and of a Project's sandbox                            |
| [Notifications](docs/features/notifications.md)                           | The native notice when a prompt finishes outside the reader's view                    |
| [Local history](docs/features/local-history.md)                           | The desktop's snapshots of a Thread's history                                         |
| [Thread archive](docs/features/thread-archive.md)                         | Archiving, restoring and pinning a Thread, and the rules that archive on their own    |
| [The workspace window](docs/features/ui-redesign.md)                      | The window's frame, sidebar, tabs, dashboard, side panel and account status           |
| [Error messages](docs/features/error-messages.md)                         | The text of the errors the window shows                                               |
| [Host API](docs/features/host-api.md)                                     | The host's REST routes and Socket.IO namespaces                                       |
| [Knowledge bundles](docs/features/knowledge-bundles.md)                   | Generating and searching Open Knowledge Format bundles                                |

### Applications, scripts and tools

- [Doric host](app/backend/doric-host/README.md): running and configuring the
  host, its REST and Socket.IO reference, persistence and security.
- [Desktop app](app/desktop/doric/README.md): the Electron main process, its
  platform contracts and its packaging.
- [Renderer shell](app/desktop/doric-renderer/README.md): the page every
  desktop window loads.
- [Fake host](scripts/fake-host/README.md): the development stand-in for the
  host.
- [`tool-okf`](tools/okf/README.md): the `okf_search` agent tool.

### Bundles

Each README describes the bundle's manifest, contracts, behavior and tests.

| Group      | Bundles                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Foundation | [`core`](bundles/foundation/core/README.md), [`host-config`](bundles/foundation/host-config/README.md), [`postgres`](bundles/foundation/postgres/README.md), [`transport`](bundles/foundation/transport/README.md)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Runtime    | [`runtime`](bundles/runtime/runtime/README.md), [`default`](bundles/runtime/default/README.md)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Providers  | [`openai`](bundles/providers/openai/README.md), [`openrouter`](bundles/providers/openrouter/README.md), [`claude`](bundles/providers/claude/README.md), [`codex`](bundles/providers/codex/README.md)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Sandboxes  | [`docker`](bundles/sandboxes/docker/README.md), [`firecracker`](bundles/sandboxes/firecracker/README.md)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Features   | [`files`](bundles/features/files/README.md), [`git`](bundles/features/git/README.md), [`terminal`](bundles/features/terminal/README.md), [`web`](bundles/features/web/README.md), [`threads`](bundles/features/threads/README.md), [`mcp`](bundles/features/mcp/README.md), [`usage`](bundles/features/usage/README.md), [`resources`](bundles/features/resources/README.md), [`screen`](bundles/features/screen/README.md), [`screen-relay`](bundles/features/screen-relay/README.md), [`comments`](bundles/features/comments/README.md), [`openui`](bundles/features/openui/README.md), [`papercraft`](bundles/features/papercraft/README.md), [`claude-login`](bundles/features/claude-login/README.md) |
| Desktop    | [`layout`](bundles/desktop/layout/README.md), [`workspace`](bundles/desktop/workspace/README.md), [`account`](bundles/desktop/account/README.md), [`chat`](bundles/desktop/chat/README.md), [`settings`](bundles/desktop/settings/README.md), [`history`](bundles/desktop/history/README.md), [`notifications`](bundles/desktop/notifications/README.md)                                                                                                                                                                                                                                                                                                                                                   |

### Packages

| Package                                                         | What it is                                                                                      |
| --------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| [`bundle`](packages/bundle/README.md)                           | The bundle platform: manifest, contracts, loader, build and distribution                        |
| [`desktop`](packages/desktop/README.md)                         | The browser code every desktop window shares: UI, read helpers, the window protocol, the loader |
| [`storage`](packages/storage/README.md)                         | The protocol of the storage backend contract                                                    |
| [`agent`](packages/agent/README.md)                             | An embeddable agent loop                                                                        |
| [`llms`](packages/llms/README.md)                               | One provider contract for chat, streaming, tool calls and model listing                         |
| [`messages`](packages/messages/README.md)                       | An in-memory conversation history ready to send to a provider                                   |
| [`tool`](packages/tool/README.md)                               | Typed, provider-neutral agent tools                                                             |
| [`oauth`](packages/oauth/README.md)                             | The OAuth authorization-code flow with PKCE and the Claude Code and Codex profiles              |
| [`sandbox`](packages/sandbox/README.md)                         | The provider-neutral sandbox contract                                                           |
| [`docker-sandbox`](packages/docker-sandbox/README.md)           | The Docker sandbox provider                                                                     |
| [`firecracker-sandbox`](packages/firecracker-sandbox/README.md) | The Firecracker microVM sandbox provider                                                        |
| [`sandpool`](packages/sandpool/README.md)                       | A process-local pool of sandbox sessions                                                        |
| [`session`](packages/session/README.md)                         | A process-local store of values keyed by ID, with single-flight creation                        |
| [`okf`](packages/okf/README.md)                                 | Generation of Open Knowledge Format bundles                                                     |
| [`victor`](packages/victor/README.md)                           | Ranked in-memory lexical, vector and hybrid search                                              |
| [`state-machine`](packages/state-machine/README.md)             | Typed state machines built from a map of handlers                                               |
| [`jsonl`](packages/jsonl/README.md)                             | Appending and reading JSON Lines files                                                          |
| [`config`](packages/config/README.md)                           | A validator for agent configuration carried in message metadata                                 |

## License

MIT ([`LICENSE`](LICENSE)).
