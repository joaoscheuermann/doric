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
  The sandbox image the [quick start](#1-prepare-the-checkout) builds ships
  Node.js, Git, `gh`, the Docker CLI and engine, Xvfb, xpra for the screen
  and esbuild
  ([`.sandbox.Dockerfile`](app/backend/doric-host/.sandbox.Dockerfile)).
  Without `DORIC_SANDBOX_IMAGE` a sandbox runs `node:22-bookworm`, which has
  Node.js and Git but no `gh`, no Docker and no screen; the Compose
  `firecracker` service sets no image, so it runs that one
  ([`docker`](bundles/sandboxes/docker/src/host/sandbox.ts) and
  [`firecracker`](bundles/sandboxes/firecracker/src/host/sandbox.ts)
  `sandbox.ts`, [`compose.yaml`](app/backend/doric-host/compose.yaml)).
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
  ([`kind.ts`](bundles/providers/claude/src/host/kind.ts)), which the settings
  window signs in through the `claude-login` bundle
  ([`claude-login`](bundles/features/claude-login/README.md),
  [Provider sign-in](docs/features/provider-sign-in.md)), are the advertised
  provider kinds. A fourth, `codex`, a ChatGPT Codex login, is enabled but not
  advertised ([`kind.ts`](bundles/providers/codex/src/host/kind.ts));
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
┌──────────────────┐   Socket.IO bridge   ┌──────────────────────────┐
│ Desktop app      │ ───────────────────▶ │ Doric host               │
│ (Electron)       │   + screen relay     │ bundles + agent runtime  │
└──────────────────┘                      └──┬──────────┬─────────┬──┘
                                             │          │         │
                                     ┌───────▼──┐  ┌────▼─────┐ ┌─▼──────────┐
                                     │PostgreSQL│  │ Project  │ │ Model      │
                                     │ history, │  │ sandboxes│ │ provider   │
                                     │ settings │  │ (Docker  │ │ (your key) │
                                     │          │  │ or Fire- │ │            │
                                     │          │  │ cracker) │ │            │
                                     └──────────┘  └──────────┘ └────────────┘
```

- The **host** listens on `DORIC_HOST:DORIC_PORT`, `0.0.0.0:3000` by default,
  loads the bundles its composition enables, and logs `Doric listening` once
  it accepts requests ([`src/index.ts`](app/backend/doric-host/src/index.ts)).
  On the branch `feat/grpc-processes`, from slice S62c3, it boots the gRPC
  platform instead: every host part runs as its own process, and the host
  serves no REST route, Socket.IO namespace or bridge of its own
  ([`docs/designs/grpc-processes.md`](docs/designs/grpc-processes.md)).
  Before that it ran the foundation, the core, the embedded bundles and the
  resident bundles in its own process, and every other installed bundle in a
  generation process it forked, which inherits its environment
  ([`boot.ts`](app/backend/doric-host/src/lib/bundles/boot.ts),
  [bundles and composition](app/backend/doric-host/README.md#bundles-and-composition)).
  Startup never applies database migrations; the `migrate` target does
  ([`project.json`](app/backend/doric-host/project.json)).
- The **composition**
  ([`composition.json`](app/backend/doric-host/composition.json)) names the
  core bundle (`core`), lists the enabled bundles, picks the bundle that
  provides each storage contract (`postgres` for `storage.backend/v1` and
  `secrets.backend/v1`), names the `resident` bundles (`host-config`,
  `transport`, `screen-relay`), lists what must be active before the host
  serves (`required`: the contracts `runtime/v2`, `executor/v1`, `sandbox/v1`,
  `models/v1` and `host-config/v1`, and the bundle `transport`), and offers
  the sandbox alternative, `alternatives.sandbox`. When `DORIC_COMPOSITION` is
  unset, `DORIC_SANDBOX_PROVIDER` picks `docker`, the default, or
  `firecracker`, and any other value selects `docker`; a composition named by
  `DORIC_COMPOSITION` boots as written
  ([`boot.ts`](app/backend/doric-host/src/lib/bundles/boot.ts),
  [`composition.ts`](packages/bundle/src/runtime/composition.ts)). The
  desktop's recovery action "Disable a bundle", which accepts any enabled
  bundle but the core, adds the bundle to the `disabled` list of
  `composition.overrides.json` beside the composition, and Git ignores that
  file ([`composition-actions.ts`](packages/bundle/src/process/composition-actions.ts),
  [`overrides.ts`](packages/bundle/src/loader/overrides.ts),
  [`.gitignore`](.gitignore)).
- The **desktop app** connects to `DORIC_HOST_URL`, or `http://127.0.0.1:3000`
  when unset ([`main.ts`](app/desktop/doric/src/main.ts),
  [`host-bridge.ts`](app/desktop/doric/src/platform/bridge/host-bridge.ts)). It
  calls no REST route: it reaches the host's services through the Socket.IO
  namespace `/doric/bridge`, sending `call`, `cancel`, `subscribe` and
  `unsubscribe`, which the host answers with `result`, `event` and `end`, and
  follows its connection status through a second connection to the same
  namespace ([`host-bridge.ts`](app/desktop/doric/src/platform/bridge/host-bridge.ts),
  [`status.ts`](app/desktop/doric/src/connection/status.ts),
  [`socket.ts`](app/backend/doric-host/src/lib/bridge/socket.ts),
  [the desktop bridge](app/backend/doric-host/README.md#the-desktop-bridge)).
  The sandbox's screen loads over HTTP and WebSocket from the host's relay
  under `/screen/<token>/`
  ([`relay.ts`](bundles/features/screen-relay/src/host/relay.ts)). The desktop
  downloads the desktop parts of the bundles through the bridge and draws every
  window with them; the shell page it loads holds no product UI
  ([`doric-renderer`](app/desktop/doric-renderer/README.md)).
- **Configuration** comes from environment variables. The host reads
  `DORIC_HOST`, `DORIC_PORT`, `DORIC_BUNDLES_PATH`, `DORIC_COMPOSITION`,
  `DORIC_SANDBOX_PROVIDER` and `DORIC_LOG_FILE` (default `doric.log` in the
  current directory, the debug log; the console shows info and above), and
  its bundles read the rest:
  `DORIC_DATABASE_URL` (required, no default), `DORIC_CREDENTIAL_KEY`,
  `DORIC_STORAGE_PATH`, `DORIC_SANDBOX_IMAGE`,
  `DORIC_SANDBOX_SSH`, `DORIC_SANDBOX_DOCKER_SOCKET`, `DORIC_SANDBOX_CPUS`
  (default 4), `DORIC_SANDBOX_MEMORY_MIB` (default 2048) and `DOCKER_HOST`; a
  `DORIC_SANDBOX_CPUS` or `DORIC_SANDBOX_MEMORY_MIB` that is not a whole
  positive number fails the activation of the `docker` bundle
  ([`src/index.ts`](app/backend/doric-host/src/index.ts),
  [`boot.ts`](app/backend/doric-host/src/lib/bundles/boot.ts),
  [`sandbox.ts`](bundles/sandboxes/docker/src/host/sandbox.ts),
  [`mapping.ts`](packages/docker-sandbox/src/lib/mapping.ts)). Compose also
  reads `DORIC_POSTGRES_USER`, `DORIC_POSTGRES_PASSWORD`, `DORIC_POSTGRES_DB`
  and `DORIC_POSTGRES_PORT` (default 5432)
  ([`compose.yaml`](app/backend/doric-host/compose.yaml)). Each variable, its
  default and its effect are listed in the host's
  [configuration](app/backend/doric-host/README.md#configuration). The desktop
  reads `DORIC_HOST_URL`, `DORIC_RENDERER_DEV_URL`, `DORIC_ELECTRON_NO_SANDBOX`,
  `DORIC_THEME` and `DORIC_SPLASH_ART`
  ([desktop configuration](app/desktop/doric/README.md#configuration)).
- **Startup fails** with `Doric failed to start` and the failing `stage`, and
  the process exits with code 1
  ([`src/index.ts`](app/backend/doric-host/src/index.ts)). This happens when
  `DORIC_DATABASE_URL` is missing, when the database is unreachable or has not
  been migrated, when `DORIC_CREDENTIAL_KEY` is malformed, and when a
  `required` contract or bundle is not active, which first logs
  `Bundle recovery mode` with the reason. A required provider lost after
  startup logs `Bundle recovery mode` and exits with code 1 as well
  ([`boot.ts`](app/backend/doric-host/src/lib/bundles/boot.ts),
  [`envelope.ts`](bundles/foundation/postgres/src/host/secrets/envelope.ts)). The
  stages and the log line each one leaves are in
  [startup and failures](app/backend/doric-host/README.md#startup-and-failures).
- How bundles are declared, built, distributed and activated is in the
  [architecture overview](docs/architecture/bundles.md) and the
  [`bundle` package](packages/bundle/README.md).

## Quick start

This guide runs the host and the desktop app on one computer. You need:

- Git, **Node.js 26** and **npm 11.13.0**, the versions CI and the host image
  use ([`ci.yml`](.github/workflows/ci.yml),
  [`.Dockerfile`](app/backend/doric-host/.Dockerfile)). Install npm with
  `npm install --global npm@11.13.0`: npm 10 refuses `npm ci` on this lockfile.
- `rustup`, which installs the Rust toolchain
  [`rust-toolchain.toml`](rust-toolchain.toml) pins. `buf` comes from npm
  (`npx buf`). `generate-proto`, which `build` and `typecheck` depend on,
  resolves the `buf.build` modules [`buf.lock`](buf.lock) pins, so the first
  build needs network access to the Buf Schema Registry or a filled buf cache.
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

The Compose `docker` host and the macOS steps below run `doric-sandbox:local`. The
provider pulls an image only when it is absent, so without this build the
pull of that tag fails and every new Project ends `failed` with
`sandbox_acquisition_failed`
([`service.ts`](bundles/runtime/runtime/src/host/domain/service.ts),
[configuration](app/backend/doric-host/README.md#configuration)).

Compose publishes PostgreSQL on `127.0.0.1:5432`, so a PostgreSQL already
listening there collides with it; set `DORIC_POSTGRES_PORT` in `.env` to
another port ([`compose.yaml`](app/backend/doric-host/compose.yaml)).

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
running. When `Doric failed to start` appears instead, its `stage` field
names the stage that failed, and the line before it shows how far startup got
([startup and failures](app/backend/doric-host/README.md#startup-and-failures)).

To run Project sandboxes as Firecracker microVMs instead, use
`--profile firecracker` and follow the `firecracker` service; it needs Linux
with `/dev/kvm` and `/dev/net/tun`, and runs privileged
([`compose.yaml`](app/backend/doric-host/compose.yaml),
[with Docker Compose](app/backend/doric-host/README.md#with-docker-compose)).
Each Firecracker sandbox has 1 CPU, 512 MiB of memory and a 4096 MiB disk
([`sandbox.ts`](bundles/sandboxes/firecracker/src/host/sandbox.ts),
[`firecracker`](bundles/sandboxes/firecracker/README.md)).

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

The script builds the desktop's generation runner, the script of the Electron
process that runs the bundles' main-process parts
([generations](app/desktop/doric/README.md#generations)), serves the renderer on
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
listed in [`sections.ts`](bundles/desktop/settings/src/client/domain/sections.ts),
and bundles add their own:

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
**Credentials** and choose them in **Versioning**, the section the `git`
bundle adds to Settings
([`versioning.tsx`](bundles/features/git/src/client/settings/versioning.tsx),
[`git`](bundles/features/git/README.md)).

### 5. Start a task

Create a **Project** in the sidebar and a **Thread** in it, and send a
prompt. A new Project is `queued` while it acquires its sandbox and `ready`
once it holds one; a Thread becomes `ready` when its Project's sandbox
arrives, and a failed acquisition ends the Project `failed` with
`sandbox_acquisition_failed`
([`service.ts`](bundles/runtime/runtime/src/host/domain/service.ts),
[states](app/backend/doric-host/README.md#states)):

> Create a small Node.js app in /workspace/hello with a README explaining how
> to run it. Run it and show me the result.

The Files and Changes panels show the work
([`files-tree.tsx`](bundles/features/files/src/client/tree/files-tree.tsx),
[`git-changes.tsx`](bundles/features/git/src/client/changes/git-changes.tsx)).
Your local checkout is not mounted into a Project: a Docker sandbox mounts
only the Project's workspace volume and, when enabled, the Docker socket
([`provider.ts`](packages/docker-sandbox/src/lib/provider.ts)), so ask the
agent to clone a repository into `/workspace`. Then try a team, or a UI
preview:

> Clone https://github.com/<you>/<repo> into /workspace. Split the open TODOs
> between child threads, have each one fix and test its part, and summarize
> what changed.

> Show me a preview of a new empty state for the projects list before you
> implement it.

On a preview, click an element and write a comment: Enter adds it to the
prompt and Shift+Enter breaks the line
([`comment-field.tsx`](bundles/features/papercraft/src/client/surface/comment-field.tsx)).
Cmd/Ctrl+Enter sends the prompt with its comments, the open one included
([`comment-flow.ts`](bundles/features/papercraft/src/client/surface/comment-flow.ts),
[`send-command.ts`](bundles/desktop/chat/src/client/services/send-command.ts),
[Papercraft](docs/features/papercraft.md)).

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
  A run that fails on a full disk (`ENOSPC`, PostgreSQL code `53100` or
  "no space left on device") pauses the queue the same way
  ([`storage-pressure.ts`](bundles/runtime/runtime/src/host/domain/storage-pressure.ts),
  [`runner.ts`](bundles/runtime/runtime/src/host/domain/runner.ts)).
- **Sandboxes hold capacity.** A Project keeps its sandbox until it is
  terminated, and deleting it removes its Docker workspace volume
  ([`workspace.ts`](packages/docker-sandbox/src/lib/workspace.ts),
  [`docker`](bundles/sandboxes/docker/README.md)). The Docker pool runs at most
  10 sandboxes at once, and a further Project waits for capacity; each
  sandbox may use 4 CPUs and 2048 MiB of memory unless `DORIC_SANDBOX_CPUS`
  and `DORIC_SANDBOX_MEMORY_MIB` say otherwise, and has a 4096 MiB writable
  layer where the daemon supports the quota. After 3 failed creations the
  waiting acquisitions fail
  ([`sandbox.ts`](bundles/sandboxes/docker/src/host/sandbox.ts),
  [`sandpool.ts`](packages/sandpool/src/lib/sandpool.ts),
  [limits](bundles/sandboxes/docker/README.md#limits)). A Firecracker sandbox keeps
  no workspace when it is recreated
  ([`firecracker`](bundles/sandboxes/firecracker/README.md)).
- **Isolation depends on the machine.** On Linux the Docker provider applies
  its own `nftables` egress rules; on macOS and Windows it relies on Docker
  Desktop's networking instead, and on any other platform sandbox creation
  fails with `Docker egress is unsupported on platform: <platform>`
  ([`host.ts`](packages/docker-sandbox/src/lib/host.ts)). A host run natively
  on Linux therefore needs a local Docker daemon, the host network namespace
  and `nft` with `CAP_NET_ADMIN`; otherwise sandbox creation fails with
  `Docker egress requires a local Linux Docker daemon`,
  `Docker egress requires access to the host network namespace` or
  `Docker egress requires nftables CAP_NET_ADMIN access`
  ([`host.ts`](packages/docker-sandbox/src/lib/host.ts),
  [natively](app/backend/doric-host/README.md#natively)). A sandbox given the
  Docker socket (`DORIC_SANDBOX_DOCKER_SOCKET=true`) holds the Docker daemon's
  authority over the machine. Compose defaults it to `false`, and the `.env`
  of the [quick start](#1-prepare-the-checkout) turns it on
  ([`compose.yaml`](app/backend/doric-host/compose.yaml),
  [`.env.example`](app/backend/doric-host/.env.example)).
- **Model calls cost money.** Every prompt calls your provider with your key,
  once per turn of the agent loop up to the turn limit
  ([`executor.ts`](bundles/runtime/default/src/host/executor.ts)), and the
  conversation footer shows what the Thread has cost
  ([`cost-breakdown.tsx`](bundles/features/usage/src/client/components/cost-breakdown.tsx)).

## Develop

Doric is an Nx and npm-workspaces monorepo in TypeScript and Rust
([`nx.json`](nx.json), [`package.json`](package.json), [`Cargo.toml`](Cargo.toml)). Its top-level folders
are:

| Folder             | What it holds                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `app/backend/`     | The host, [`doric-host`](app/backend/doric-host/README.md), and its end-to-end suite `doric-host-e2e`                                                                                                                                                                                                                                                                                                                                                    |
| `app/desktop/`     | The Electron app [`doric`](app/desktop/doric/README.md) (Nx project `doric-app`), the shell [`doric-renderer`](app/desktop/doric-renderer/README.md), `doric-platform`, which builds the shared platform packages, their import map, the theme stylesheet and the bundle JSON schemas into the app's `assets/` ([`build.mjs`](app/desktop/doric-platform/build.mjs)), and the end-to-end suite `doric-e2e` (Nx project `doric-app-e2e`)                  |
| `bundles/<group>/` | The 33 bundles, each with a `manifest.json`, a README and an `AGENTS.md`; their map is [Bundles](#bundles)                                                                                                                                                                                                                                                                                                                                               |
| `packages/`        | Libraries the host, the app and the bundles build on; see [Packages](#packages)                                                                                                                                                                                                                                                                                                                                                                          |
| `tools/`           | [`tool-okf`](tools/okf/README.md), the `okf_search` agent tool                                                                                                                                                                                                                                                                                                                                                                                           |
| `scripts/`         | Command-line scripts, among them the [fake host](scripts/fake-host/README.md)                                                                                                                                                                                                                                                                                                                                                                            |
| `tests/`           | The repository checks run by `npm run lint:test` and `npm run test:fake-host`, and [`boundary-exceptions.json`](tests/boundary-exceptions.json), the list of standing boundary violations ([Boundaries](docs/architecture/bundles/boundaries.md)), and [`contract-inventory-allow.json`](tests/contract-inventory-allow.json), the contract members the inventory check allows to be typed `any` ([Bundle processes](docs/features/bundle-processes.md)) |
| `benchmarks/`      | [`proto-codec`](benchmarks/proto-codec), the codec benchmark of phase 0 of the bundle process model ([Bundle processes](docs/features/bundle-processes.md))                                                                                                                                                                                                                                                                                              |

Use `npx nx show projects` to list the projects and
`npx nx show project <project>` to see a project's targets, including those
the `@nx/js/typescript` and `@nx/webpack` plugins infer
([`nx.json`](nx.json)).

### Scripts of the root

Each runs from the repository root as `npm run <script>`
([`package.json`](package.json)).

| Script                   | What it runs                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `doric:dev`              | The desktop app in development, as in [step 3](#3-open-the-desktop-app)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `doric:docker:build`     | `docker compose -p doric --env-file app/backend/doric-host/.env -f app/backend/doric-host/compose.yaml --profile docker up -d --build`, the Compose host of [step 2](#2-start-the-host) under the project name `doric`                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `doric:fake-host`        | The development [fake host](#develop-bundles-without-the-host)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `doric:spawn-agent`      | `-- --prompt <text> [--url <url>] [--terminate]`: creates a Project and its root Thread on a running host (`DORIC_URL` or `http://127.0.0.1:3000`), sends the prompt and prints one JSON line of metadata per event (`projectId`, `threadId`, `promptId`, `sequence`, `type`), never its body, until the prompt finishes. It exits 1 when the prompt fails or is cancelled, when the Thread ends first, or when a request fails. `--terminate` terminates the Project at the end; without it the Project stays reserved ([`spawn-agent.mjs`](scripts/spawn-agent.mjs), [command-line client](app/backend/doric-host/README.md#command-line-client)) |
| `okf`                    | `-- <model-id>`: writes the Open Knowledge Format bundle of this repository to `.agents/bundles/project`, with the OpenAI-compatible endpoint `OKF_BASE_URL` (default `http://localhost:1234/v1`) and the key `OKF_API_KEY`; without a model id it exits 1 ([`okf.mjs`](scripts/okf.mjs), [`generate.ts`](packages/okf/src/lib/generate.ts), [Knowledge bundles](docs/features/knowledge-bundles.md))                                                                                                                                                                                                                                               |
| `claude:oauth`           | A Claude Code OAuth sign-in in the browser (`-- --no-browser` or `CLAUDE_OAUTH_NO_BROWSER=1` to paste the code). It writes the authorization value to the root `.env` under `CLAUDE_AUTHORIZATION`, or under the key `CLAUDE_OAUTH_OUTPUT_KEY` names. Before signing in, it reuses an existing Claude Code login (`CLAUDE_CODE_OAUTH_TOKEN`, or a `~/.claude` login) that has no expiry or stays valid for 30 more days ([`claude-oauth.mjs`](scripts/claude-oauth.mjs), [`claude-oauth.ts`](packages/oauth/src/lib/claude-oauth.ts), [Provider sign-in](docs/features/provider-sign-in.md))                                                        |
| `codex:oauth`            | A Codex OAuth sign-in in the browser, written to the root `.env` under `CODEX_AUTHORIZATION`, or under the key `CODEX_OAUTH_OUTPUT_KEY` names. It has no paste mode and reuses no existing login ([`codex-oauth.mjs`](scripts/codex-oauth.mjs), [`codex-oauth.ts`](packages/oauth/src/lib/codex-oauth.ts))                                                                                                                                                                                                                                                                                                                                          |
| `lint`, `lint:fix`       | Biome's linter over the repository, checking or fixing ([`biome.json`](biome.json))                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `format`, `format:check` | Biome's formatter, then Prettier, writing or checking                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `lint:test`              | The tests of the Biome configuration, of the bundle boundaries and of the contract inventory ([`lint.test.mjs`](tests/lint.test.mjs), [`boundaries.test.mjs`](tests/boundaries.test.mjs), [`contract-inventory.test.mjs`](tests/contract-inventory.test.mjs), [Boundaries](docs/architecture/bundles/boundaries.md))                                                                                                                                                                                                                                                                                                                                |
| `test:fake-host`         | The test of the fake host's bundle staging; it imports the built `bundle` package, so run `npx nx run bundle:build` first ([`fake-host-bundles.test.mjs`](tests/fake-host-bundles.test.mjs), [fake host README](scripts/fake-host/README.md))                                                                                                                                                                                                                                                                                                                                                                                                       |

### Build and test

```sh
npx nx run doric-host:build           # builds every type:bundle project, stages them into app/backend/doric-host/dist/bundles, then compiles the host
npx nx run doric-app:build            # the desktop app
npx nx run doric-app:make             # the desktop installers, in dist/executables
npx nx run bundle-<name>:test         # one bundle, for example bundle-chat
npx nx test <package>                 # one package, for example agent
npx nx run doric-host-e2e:e2e         # the host workflow against a disposable database and Docker sandbox
npx nx run doric-app-e2e:e2e          # the desktop app under Electron
npx nx run @org/source:proto-export   # the .proto contracts into dist/proto
npx nx run proto-codec:bench          # the codec benchmark, into dist/proto-codec
npx nx run-many -t lint test format-check --projects=tag:type:rust   # the Rust projects
```

The targets are in [`doric-host/project.json`](app/backend/doric-host/project.json),
[`doric/project.json`](app/desktop/doric/project.json) (with the
[desktop app README](app/desktop/doric/README.md)),
[`doric-host-e2e/project.json`](app/backend/doric-host-e2e/project.json) and
[`doric-e2e/project.json`](app/desktop/doric-e2e/project.json). CI runs
neither end-to-end suite.

Every bundle has the targets `build`, `typecheck` and `test`, under the Nx name
`bundle-<directory>` ([`bundles/desktop/chat/project.json`](bundles/desktop/chat/project.json));
`bundle-postgres` also has `prisma-generate` and `migrate`
([`postgres/project.json`](bundles/foundation/postgres/project.json)).
`bundle` and every bundle with `.proto` contracts under its `proto/doric/`
(`bundle-transport` holds the eight public `doric/api/*/v1`) also have the
cached target `generate-proto`, which `build` and `typecheck` depend on: it runs
`buf generate` with [`buf.gen.yaml`](buf.gen.yaml) into the project's
`src/contracts/gen/`, which Git ignores, exported as `./contracts/gen/*`;
`buf.gen.yaml`'s `map_imports` make a generated file import another owner's
code through that export. `bundle`'s `generate-proto` depends on
`@org/source:proto-export`. To add or change a contract, edit its `.proto`, then
run `npx buf lint` and the owner's `generate-proto`. Through phase 6 the zod
`define*` contracts stay the runtime truth and the `.proto` files describe the
target shape, so a change to a zod contract also updates its `.proto` and its
row in
[`contract-inventory.md`](docs/designs/grpc-processes/contract-inventory.md);
`inventory-targets.test.ts` checks only ids and rows
([Bundle processes](docs/features/bundle-processes.md)). The root
project `@org/source` has `proto-export` (writes `dist/proto`) and `proto-check`, which builds `bundle` and runs the proto check
([`project.json`](project.json)). Some packages have further targets that need outside resources: `e2e` in
[`docker-sandbox`](packages/docker-sandbox/README.md),
[`firecracker-sandbox`](packages/firecracker-sandbox/README.md) and
[`sandpool`](packages/sandpool/README.md), `conformance-live` in
[`llms`](packages/llms/README.md), and `benchmark` in
[`victor`](packages/victor/README.md).

A bundle is a directory `bundles/<group>/<id>` with a `manifest.json` and a
`project.json` named `bundle-<id>` and tagged `type:bundle`.
`doric-host:build-bundles` builds every project with that tag and stages every
such directory; the host loads only the bundles `composition.json` lists in
`enabled` ([composition and distribution](docs/architecture/bundles/composition-and-distribution.md),
[`project.json`](app/backend/doric-host/project.json),
[`composition.json`](app/backend/doric-host/composition.json),
[bundles and composition](app/backend/doric-host/README.md#bundles-and-composition)).
A new bundle needs `npm install` under npm 11.13.0 and the updated
`package-lock.json`, because CI installs with `npm ci`
([Boundaries](docs/architecture/bundles/boundaries.md)).

CI runs these checks, in this order, on Node.js 26 with npm 11.13.0, the Rust
toolchain `rust-toolchain.toml` pins and a PostgreSQL service, after `npm ci`,
whose `postinstall` runs `patch-package` to apply `patches/`
([`ci.yml`](.github/workflows/ci.yml)):

```sh
npx nx sync:check
npx buf lint
npx nx run @org/source:proto-check
npx buf breaking --against ".git#ref=$BASE_SHA"
npm run lint:test
npm run format:check
npm run lint
DORIC_DATABASE_URL=postgresql://doric:doric@127.0.0.1:5432/doric npx nx run doric-host:migrate
DORIC_TEST_DATABASE_URL=postgresql://doric:doric@127.0.0.1:5432/doric npx nx test doric-host
DORIC_TEST_DATABASE_URL=postgresql://doric:doric@127.0.0.1:5432/doric npx nx run-many -t test --projects=tag:type:bundle
npx nx run-many -t test -p bundle,desktop,doric-platform,doric-app
npm run test:fake-host
npx nx test agent
npx nx run-many -t lint test format-check --projects=tag:type:rust
npx nx run-many -t build typecheck
```

`buf breaking` runs only on a pull request whose base has a `buf.yaml` and
`.proto` files; otherwise CI skips it with a message.

Besides these, the jobs below run `bundle:conformance` and `bundle:bench-rk4`.
CI runs no other test target: not the tests of `doric-renderer`, `tool-okf`
and the packages other than `agent`, `bundle` and `desktop`, nor
[`spawn-agent.test.mjs`](scripts/tests/spawn-agent.test.mjs). Run a package's
tests with `npx nx test <package>` and the script's with
`node --test scripts/tests/spawn-agent.test.mjs`.

A second CI job, `sea-spike`, runs on `ubuntu-latest` and `ubuntu-24.04-arm`
with a PostgreSQL service: it installs npm 11.13.0 and the Rust toolchain,
builds `bundle` and today's host, applies the migrations, runs
`node scripts/sea-spike.mjs` and uploads `dist/sea-spike/results-*.json` as the
artifact `sea-spike-<runner>` ([`ci.yml`](.github/workflows/ci.yml),
[Bundle processes](docs/features/bundle-processes.md)).

A third job, `conformance`, runs on `ubuntu-latest` and `ubuntu-24.04-arm`:
after `npm ci` it runs `npx nx run bundle:conformance`, the protocol
conformance suite on the TypeScript SDK's fixture, and, on `ubuntu-latest`
only, `npx nx run bundle:bench-rk4` with `RK4_NO_FAIL=1`, which reports RK4's
numbers without failing the job ([`ci.yml`](.github/workflows/ci.yml),
[Bundle processes](docs/features/bundle-processes.md)).

Tests that need PostgreSQL read `DORIC_TEST_DATABASE_URL` and skip without it.
Its role must be allowed to create databases and schemas, because each case
creates its own and drops it
([`helpers/host.ts`](app/backend/doric-host/tests/helpers/host.ts),
[`database.ts`](bundles/foundation/postgres/tests/support/database.ts),
[`store/support.ts`](bundles/runtime/runtime/tests/store/support.ts)). CI uses
`postgres:18.4-alpine3.24` with user, password and database `doric`
([`ci.yml`](.github/workflows/ci.yml)). Locally, the PostgreSQL that Compose
starts in [step 2](#2-start-the-host) serves: its role is the image's
`POSTGRES_USER`, a superuser, so `DORIC_TEST_DATABASE_URL` is
`postgresql://doric:<DORIC_POSTGRES_PASSWORD>@127.0.0.1:<DORIC_POSTGRES_PORT, default 5432>/doric`,
with the values of `.env`
([`compose.yaml`](app/backend/doric-host/compose.yaml)). Tests that start a
Docker sandbox run only with `DORIC_TEST_SANDBOX=true` and a reachable Docker.
`DORIC_TEST_COALESCE_SIZE=1` adds the size report of the
[`postgres`](bundles/foundation/postgres/README.md#build-and-test) bundle, and
`DORIC_TEST_ADAPTER_CAPTURE=true` runs the adapter capture of the
[`runtime`](bundles/runtime/runtime/README.md#build-and-test) bundle, which
fails with a module-not-found error. `doric-host-e2e:e2e` fails instead of
skipping without both `DORIC_TEST_DATABASE_URL` and `DORIC_TEST_SANDBOX=true`
([`doric-host-e2e/project.json`](app/backend/doric-host-e2e/project.json),
[host README](app/backend/doric-host/README.md#validation)). Rules for
changing the code, and the checks to run before a change is complete, are in
[`AGENTS.md`](AGENTS.md) and the `AGENTS.md` of each folder.

### Develop bundles without the host

`npm run doric:fake-host` starts a development stand-in for the host on
`127.0.0.1:3000`, the address the desktop uses by default
([`main.mjs`](scripts/fake-host/main.mjs)). It serves the staged bundles of
`app/backend/doric-host/dist/bundles`, staging the built bundles itself into
`tmp/fake-host/bundles` when that directory is absent, and answers from an
in-memory workspace: no PostgreSQL, no sandbox and no model provider
([`bundles.mjs`](scripts/fake-host/bundles.mjs)). A call it does not serve is
refused with `unavailable` and logged as `?? UNKNOWN <contract> <method>`
([`contracts.mjs`](scripts/fake-host/contracts.mjs),
[`log.mjs`](scripts/fake-host/log.mjs)).

It runs on the built `bundle` package, and its own staging fails for a bundle
that is not built. Build the `bundle` package and the bundles first:
`npx nx run doric-host:build-bundles` builds every project tagged
`type:bundle`, and with them `bundle`, and stages them into
`app/backend/doric-host/dist/bundles`
([`project.json`](app/backend/doric-host/project.json)).

```sh
npx nx run doric-host:build-bundles
npm run doric:fake-host   # one terminal
npm run doric:dev         # another
```

When a real host already holds port 3000, start the fake host on another port
with `-- --port <port>` or `DORIC_FAKE_PORT`, and start the desktop with
`DORIC_HOST_URL` set to the URL it prints
([`main.mjs`](scripts/fake-host/main.mjs),
[`main.ts`](app/desktop/doric/src/main.ts)).

After `npx nx run doric-host:build-bundles`,
`curl http://127.0.0.1:3000/reload` rebuilds the catalog from the staged
directory chosen at start and tells the desktop a new generation exists. A
fake host that staged its own copy under `tmp/fake-host/bundles` must be
restarted instead ([`main.mjs`](scripts/fake-host/main.mjs),
[`server.mjs`](scripts/fake-host/server.mjs)).

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

| Feature                                                                   | What it covers                                                                                                       |
| ------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| [Projects and Threads](docs/features/projects-and-threads.md)             | The life of a Project and of a Thread: states, the queue, leases, recovery at startup                                |
| [Conversation](docs/features/conversation.md)                             | The transcript, the composer, the trail, the lifecycle markers, the footer                                           |
| [Stop, steering and the queue of inputs](docs/features/prompt-control.md) | Stopping a prompt, steering it, and the queue of inputs                                                              |
| [Delegation](docs/features/delegation.md)                                 | Child Threads and the tools that create and steer them                                                               |
| [Default agent](docs/features/default-agent.md)                           | The executor: system prompt, tool set, model resolution, provider history                                            |
| [Skills](docs/features/skills.md)                                         | The skill catalog, `load_skill` and the skill sources                                                                |
| [Coding workflow](docs/features/coding-workflow.md)                       | The coding workflow, a skill loaded on demand                                                                        |
| [Context compaction](docs/features/context-compaction.md)                 | Compaction of a Thread's context                                                                                     |
| [Attachments](docs/features/attachments.md)                               | Images sent to the model as attachments                                                                              |
| [Models and providers](docs/features/models-and-providers.md)             | Provider kinds, model catalogs, the configured providers and the default execution                                   |
| [Per-thread model](docs/features/per-thread-model.md)                     | A Thread's own provider, model and effort                                                                            |
| [Provider sign-in](docs/features/provider-sign-in.md)                     | The Claude Code sign-in and the Claude and Codex OAuth profiles                                                      |
| [Credentials](docs/features/credentials.md)                               | Named credentials and the secret store                                                                               |
| [Settings](docs/features/settings.md)                                     | The settings window: its sections, autosave and search                                                               |
| [Files](docs/features/files.md)                                           | The file tools, the Files panel, the file tabs and the viewer                                                        |
| [cwd tool](docs/features/cwd-tool.md)                                     | A Thread's working directory and the `cwd` tool                                                                      |
| [Git](docs/features/git.md)                                               | Branches, the Changes view, comparisons, the `git` tool                                                              |
| [Terminal](docs/features/terminal.md)                                     | Tracked commands and manual terminal sessions                                                                        |
| [Screen](docs/features/screen.md)                                         | The screen of a Project's sandbox, and its relay                                                                     |
| [Web research](docs/features/web-research.md)                             | The web tool                                                                                                         |
| [MCP servers](docs/features/mcp.md)                                       | MCP servers per Project: their tools and their OAuth sign-in                                                         |
| [Sandboxes](docs/features/sandboxes.md)                                   | One sandbox per Project: Docker, Firecracker and the pool                                                            |
| [Generative UI](docs/features/generative-ui.md)                           | UI the agent writes in its answer, and the question form                                                             |
| [Diagrams in OpenUI fences](docs/features/openui-diagrams.md)             | The diagram components                                                                                               |
| [Papercraft](docs/features/papercraft.md)                                 | Live previews of a Project's code and the canvas window                                                              |
| [Comments](docs/features/comments.md)                                     | Anchored comments and their attended state                                                                           |
| [Usage](docs/features/usage.md)                                           | A Thread's usage, cost and context capacity                                                                          |
| [Resource monitor](docs/features/resource-monitor.md)                     | The monitor of the host machine and of a Project's sandbox                                                           |
| [Notifications](docs/features/notifications.md)                           | The native notice when a prompt finishes outside the reader's view                                                   |
| [Local history](docs/features/local-history.md)                           | The desktop's snapshots of a Thread's history                                                                        |
| [Thread archive](docs/features/thread-archive.md)                         | Archiving, restoring and pinning a Thread, and the rules that archive on their own                                   |
| [The workspace window](docs/features/ui-redesign.md)                      | The window's frame, sidebar, tabs, dashboard, side panel and account status                                          |
| [Error messages](docs/features/error-messages.md)                         | The text of the errors the window shows                                                                              |
| [Host API](docs/features/host-api.md)                                     | The host's REST routes and Socket.IO namespaces                                                                      |
| [Knowledge bundles](docs/features/knowledge-bundles.md)                   | Generating and searching Open Knowledge Format bundles                                                               |
| [Bundle isolation](docs/features/bundle-isolation.md)                     | The boundary model: its rules, the manifest, the import paths between bundles, the CI checks and the exceptions file |
| [Bundle processes](docs/features/bundle-processes.md)                     | The bundle process model: one process per bundle, `.proto` contracts, Rust, and the phase 0 measurements             |

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
