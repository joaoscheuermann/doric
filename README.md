# Doric

**A self-hosted desktop workspace where AI agents build software in a sandbox
of their own, and you stay in control of every step.**

Give an agent a task and Doric hands it a real development environment: files,
Git, a terminal, the web, and a screen it can run apps on. The agent works
there, not on your laptop. Larger tasks can be split across a team of agents
that you can inspect, steer and stop at any time. You run the backend and
choose the model provider. Your code, conversations and keys stay on
infrastructure you control.

> **Early development:** Doric does not yet have authentication. Run it locally
> or on an isolated, trusted network. Do not expose its API to the internet.

## Why Doric

- **Agents get their own computer, not yours.** Each Project runs in its own
  sandbox with Node.js, Git, the GitHub CLI and Docker preinstalled. Agents can
  install packages, run servers and break things without touching your machine.
  Your local checkout is never mounted.
- **One agent can run a team.** An agent can split a large task into child
  Threads, hand each one a self-contained job and collect the results. Every
  child is a normal conversation you can open, read and redirect.
- **Review UI like a designer, not like a diff.** With
  [Papercraft](#papercraft-see-it-point-at-it-ship-it), the agent shows you a
  live preview of the interface built from your real components. You pin
  comments on the exact element you mean, and the agent changes the exact line
  of code behind it.
- **Nothing happens out of sight.** Browse the Project's files, review Git
  diffs, follow the agent's terminals, watch apps on the sandbox's screen, and
  see what every Thread, including its children, has cost you.
- **Your models, your infrastructure.** Use OpenRouter or any OpenAI
  Responses-compatible endpoint, choose the model and reasoning effort, and
  keep history in your own PostgreSQL database, with credentials encrypted at
  rest.
- **Built to be extended.** Tools, skills, model providers, sandboxes, storage
  and even the desktop UI are all bundles. Add what you need, or reuse the
  agent runtime and model packages in your own TypeScript projects.

## Papercraft: see it, point at it, ship it

Asking an agent for UI changes usually means reading a diff and imagining the
result, or describing in words which button you mean. Papercraft removes both
problems.

- **The agent shows the change.** It publishes a live preview as a node in the
  conversation: a self-contained HTML page or one of your Project's own React
  components, compiled and running with real state, hooks and interactions.
- **You point at what you mean.** Click any element and leave a comment pinned
  to it, Figma-style. Every element is stamped with its source `file:line`, so
  the comment reaches the agent as a precise instruction about specific code.
- **The agent answers and revises.** It replies in each comment thread, asks a
  pointed question when a comment is ambiguous, resolves what it fixed, and
  publishes a new revision beside the previous one so you can compare. Pins
  follow their element from one revision to the next.
- **It fits your stack.** Existing Storybook stories, `.storybook/preview`
  providers and decorators, and your Tailwind v4 theme in light and dark all
  work. If there is no story, the agent writes a draft one outside your source
  tree.
- **You choose the level of control.** By default the agent implements the
  change and your comments steer the next round. Turn on review in
  **Settings → Review**, and the agent is told to wait for your approval
  before it writes the change into the Project's code.

Expand any preview into a modal over the conversation to pan, zoom, isolate
elements, browse the element tree and switch revisions. See the
[Papercraft bundle](bundles/features/papercraft/README.md) for details.

## What you can do

- **Organize work into Projects and Threads.** A **Project** owns a sandbox and
  its files. A **Thread** is a conversation with its own history and prompt
  queue. Threads in the same Project share files and can run at the same time.
- **Delegate to multiple agents.** Agents create child Threads, assign tasks,
  send follow-ups, read results and close finished work. Open any child to take
  over the conversation yourself.
- **Work with real development tools.** Agents find, read, edit and write
  files, run commands and use Git inside the sandbox, and research on the web.
  Open a manual terminal when you want to work alongside them.
- **Review before you ship.** Comment on live UI previews with Papercraft,
  inspect project files, review Git diffs, switch branches, watch agent
  terminals, and open the sandbox's screen in its own window to see graphical
  apps the agent is running.
- **Stay in control of execution.** Queue prompts, edit or remove them before
  they run, steer a running prompt, and pause and resume work. Get a desktop
  notification when a prompt finishes (on macOS, only from a code-signed
  build).
- **Pick up where you left off.** PostgreSQL keeps every conversation and Docker
  volumes keep Project workspaces across backend restarts.
- **Keep an eye on cost.** With OpenRouter, the conversation footer shows the
  context used and the reported cost of the Thread and all its children.
- **Integrate with other tools.** REST and Socket.IO expose Projects, Threads
  and execution events to other clients.

## How it works

```text
┌──────────────────┐   REST + Socket.IO   ┌──────────────────────────┐
│ Desktop app      │ ───────────────────▶ │ Doric host               │
│ (Electron)       │                      │ agent runtime + bundles  │
└──────────────────┘                      └──┬──────────┬─────────┬──┘
                                             │          │         │
                                     ┌───────▼──┐  ┌────▼─────┐ ┌─▼──────────┐
                                     │PostgreSQL│  │ Project  │ │ Model      │
                                     │ history, │  │ sandboxes│ │ provider   │
                                     │ settings │  │ (Docker) │ │ (your key) │
                                     └──────────┘  └──────────┘ └────────────┘
```

- The **desktop app** is where you create Projects, chat with agents and
  review their work. It talks only to your host.
- The **host** runs the agent loop for each Thread, gives agents their tools,
  and streams every step back to the app as it happens.
- **Bundles** supply almost everything the host and the app do: tools, skills,
  model providers, sandboxes, storage and the UI. The host's
  [composition](app/backend/doric-host/composition.json) decides which ones
  are enabled.

## Quick start

This guide runs the backend and desktop app on the same computer. You need:

- Git, **Node.js 22.12+ in the 22.x line**, and **npm 10** (matching the build
  image).
- Docker with Docker Compose v2, running and accessible to your user.
- A model provider account and API key; the example below uses OpenRouter.
- A fresh PostgreSQL database, provided by Compose below.

The full Compose backend requires **Linux**. On **macOS**, use the local
backend alternative in step 2 with Docker Desktop. Run all commands from the
repository root, in a POSIX shell.

### 1. Prepare the checkout

Clone this repository, enter its directory, and install dependencies:

```sh
npm ci
cp app/backend/doric-host/.env.example app/backend/doric-host/.env
openssl rand -hex 24
openssl rand -base64 32
```

Edit `app/backend/doric-host/.env`: use the first generated value for
`DORIC_POSTGRES_PASSWORD` and the second for `DORIC_CREDENTIAL_KEY`. Keep the
default database and username (`doric`). This file is ignored by Git. Keep the
credential key across restarts: stored secrets cannot be decrypted without it.

Build the sandbox image, which includes Node.js, Git, the GitHub CLI, Docker,
and the system libraries Electron needs, with Xvfb for headless runs:

```sh
docker build -f app/backend/doric-host/.sandbox.Dockerfile -t doric-sandbox:local app/backend/doric-host
```

### 2. Start the backend

**Linux — Docker Compose:**

```sh
docker compose --env-file app/backend/doric-host/.env -f app/backend/doric-host/compose.yaml --profile docker up -d --build
docker compose --env-file app/backend/doric-host/.env -f app/backend/doric-host/compose.yaml logs -f docker
```

Compose starts PostgreSQL, applies database migrations, and starts the backend.
Wait for `Doric listening`, then press Ctrl+C to leave the log view; the services
keep running. The first image build can take several minutes.

<details>
<summary>macOS — run the backend locally with Docker Desktop</summary>

Start only PostgreSQL, then load the values from the file you just edited:

```sh
docker compose --env-file app/backend/doric-host/.env -f app/backend/doric-host/compose.yaml up -d --wait postgres
set -a
. ./app/backend/doric-host/.env
set +a
export DORIC_DATABASE_URL="postgresql://${DORIC_POSTGRES_USER}:${DORIC_POSTGRES_PASSWORD}@127.0.0.1:${DORIC_POSTGRES_PORT:-5432}/${DORIC_POSTGRES_DB}"
export DORIC_HOST=127.0.0.1
export DORIC_SANDBOX_PROVIDER=docker
export DORIC_SANDBOX_IMAGE=doric-sandbox:local
export DORIC_SANDBOX_SSH=false
export DORIC_SANDBOX_DOCKER_SOCKET=true
npx nx run doric-host:migrate
npx nx serve doric-host
```

Keep this terminal open. Repeat the environment-loading and export commands
when starting the backend in a new shell. With Docker Desktop, the native
host's free-space check measures the current directory by default, not the
PostgreSQL volume inside Docker's VM; monitor Docker's available disk space too.

</details>

In another terminal, confirm the API responds:

```sh
curl --fail http://127.0.0.1:3000/projects
```

Port `3000` serves the API. The desktop app connects to that address; it is not
a browser interface.

### 3. Open the desktop app

In a separate terminal at the repository root:

```sh
npm run doric:dev
```

This starts the renderer and Electron app together. Keep the terminal open and
wait for the app to show **Connected**.

### 4. Connect a model

Open **Settings** from the conversation footer:

1. In **Credentials**, add an `API_TOKEN` credential with your OpenRouter API
   key, or fill the existing `OPENROUTER_API_KEY` credential.
2. In **Providers**, add or edit a provider. Choose **OpenRouter** as
   its kind, give it a name, and select that credential. Keep the default
   endpoint and Models URL, then select a model that supports tool calling.
3. In **Execution**, choose that provider and model, set the reasoning effort
   when available, and choose a turn limit to bound each prompt's agent loop.
4. Wait for settings to finish saving before sending your first prompt.

Provider keys are stored through **Credentials**; setting an
`OPENROUTER_API_KEY` environment variable alone does not configure the current
platform. For commits and private GitHub repositories, also configure your Git
identity and GitHub token under **Credentials** and **Versioning**.

### 5. Start your first task

Create a **Project** in the sidebar, then create a **Thread** inside it. Wait
for the environment to finish preparing and send a prompt, for example:

> Create a small Node.js app in /workspace/hello with a README explaining how
> to run it. Run it and show me the result.

Use the Files and Changes panels to inspect the work. You can also ask the
agent to clone a repository into `/workspace` and work there; your local
checkout is not automatically mounted into the Project.

Then try something bigger:

> Clone https://github.com/<you>/<repo> into /workspace. Split the open TODOs
> between child threads, have each one fix and test its part, and summarize
> what changed.

Or try Papercraft on a UI change:

> Show me a preview of a new empty state for the projects list before you
> implement it.

Click an element in the preview, leave a comment, and send it with
`Cmd/Ctrl+Enter`.

## Things to know

- **No authentication or user access controls yet.** Anyone who can reach the
  backend can access its API, change settings, and run work. Compose binds it
  to `0.0.0.0:3000`; restrict access at the host/network level. Credential
  encryption does not provide API authentication.
- **Active development.** Interfaces and database schemas can change before
  1.0. Back up data you care about; incompatible older databases may need
  explicit recreation, and startup never resets them for you.
- **Agent actions have real effects.** Threads share their Project workspace.
  Pausing a conversation or rewinding it through the API does not undo file
  changes, commands, or
  remote Git operations. Review changes before publishing them.
- **Usage consumes resources.** Model calls can incur provider charges. Projects
  retain sandbox capacity until terminated; deleting a Project also removes
  its Docker workspace. The host pauses execution at 10% free storage or less,
  or if the storage check fails; free space and explicitly resume the queue.
- **Isolation depends on the host.** Docker Desktop uses its normal bridge/NAT
  networking without Doric's Linux egress firewall rules. The Firecracker
  Compose profile is an advanced Linux/KVM development option, and its
  workspace files do not persist across sandbox recreation.

To stop the Linux Compose backend while retaining its database and Project
volumes:

```sh
docker compose --env-file app/backend/doric-host/.env -f app/backend/doric-host/compose.yaml --profile docker down
```

For the macOS path, stop the native backend with Ctrl+C and use the same Compose
command to stop PostgreSQL. Avoid `down -v` unless you intend to delete the
Compose volumes, including the database.

## Build on Doric

Doric is a TypeScript monorepo, and its pieces are meant to be reused.

| You want to…                              | Start here                                                                                                                                                                                                                        |
| ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Run, configure or integrate with the host | [Backend and API](app/backend/doric-host/README.md)                                                                                                                                                                               |
| Work on the desktop app                   | [Desktop app](app/desktop/doric/README.md), [renderer](app/desktop/doric-renderer/README.md)                                                                                                                                      |
| Add tools, skills, providers or UI        | [Bundle platform](packages/bundle/README.md), [core services](bundles/foundation/core/README.md)                                                                                                                                  |
| See how the built-in agent tools work     | [Files](bundles/features/files/README.md), [Git](bundles/features/git/README.md), [Threads](bundles/features/threads/README.md), [Papercraft](bundles/features/papercraft/README.md), [drawio](bundles/features/drawio/README.md) |
| Embed an agent loop in your own app       | [Agent runtime](packages/agent/README.md), [model integrations](packages/llms/README.md)                                                                                                                                          |
| Run code in isolated sandboxes            | [Sandbox](packages/sandbox/README.md), [Docker](packages/docker-sandbox/README.md), [pool](packages/sandpool/README.md)                                                                                                           |
| Contribute to the repository              | [GROUNDING.md](GROUNDING.md) and [AGENTS.md](AGENTS.md)                                                                                                                                                                           |

Each package owns its technical README. Use `npx nx show projects` to discover
the workspace and `npx nx show project <project>` to inspect its commands.

### Develop bundles without a full backend

`npm run doric:fake-host` starts a **development-only** host inside the
repository: the `doric.catalog/v1` distribution the desktop downloads is the
staged bundle build (`app/backend/doric-host/dist/bundles`, staged on demand
when absent), and the app-level contracts it answers come from an in-memory
workspace — no Postgres, no Docker sandbox, no agent runtime. It listens on
`127.0.0.1:3000`, the address the desktop already uses, so the app needs no
configuration:

```sh
npm run doric:fake-host   # one terminal
npm run doric:dev         # another
```

It prints every contract call and refuses what it does not serve with
`unavailable`, logged as `?? UNKNOWN <contract> <method>`, so the gap is
visible while working on a bundle. `GET /reload` republishes the catalog after
a bundle rebuild. See [`scripts/fake-host/README.md`](scripts/fake-host/README.md).
