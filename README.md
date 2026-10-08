# Doric

Doric is a desktop workspace for building software with AI agents. Give an
agent a task, let it work with files, Git, and a terminal in a dedicated project
environment, and follow its progress in one place. For larger tasks, agents can
delegate work to child conversations that you can inspect and steer yourself.

You run the backend and choose the model provider. Doric brings the
conversations, execution environment, and code changes together.

> **Early development:** Doric does not yet have authentication. Run it locally
> or on an isolated, trusted network. Do not expose its API to the internet.

## What you can do

- **Keep work organized.** Each **Project** owns a sandbox and its files. Each
  **Thread** is a conversation with its own history and prompt queue. Threads
  in the same Project share files and can run concurrently.
- **Delegate to multiple agents.** Agents can create child Threads, assign
  tasks, and receive their results. You can open any child to follow up.
- **Work with real development tools.** Agents can find, read, edit, and write
  files, run commands, use Git, and access the web inside the sandbox. Open a
  manual terminal when you want to work alongside them.
- **Inspect the result.** Browse project files, review Git diffs, switch
  branches, and watch agent terminals from the desktop app.
- **Control execution.** Queue prompts, edit or remove inputs before they run,
  pause and resume work, and rewind a conversation. PostgreSQL preserves
  conversation history; Docker volumes preserve Project workspaces across
  backend restarts.
- **Choose your models.** Configure OpenAI, OpenRouter, Codex, LM Studio, or a
  compatible endpoint, with model and reasoning controls. Unified OpenRouter
  also supplies context capacity and reported costs for the usage display.
- **Extend or integrate.** Tool and skill bundles extend the agent; REST and
  Socket.IO expose Projects, Threads, and execution events to other clients.

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
cp agents/doric/.env.example agents/doric/.env
openssl rand -hex 24
openssl rand -base64 32
```

Edit `agents/doric/.env`: use the first generated value for
`DORIC_POSTGRES_PASSWORD` and the second for `DORIC_CREDENTIAL_KEY`. Keep the
default database and username (`doric`). This file is ignored by Git. Keep the
credential key across restarts: stored secrets cannot be decrypted without it.

Build the sandbox image, which includes Node.js, Git, and the GitHub CLI:

```sh
docker build -f agents/doric/.sandbox.Dockerfile -t doric-sandbox:local agents/doric
```

### 2. Start the backend

**Linux — Docker Compose:**

```sh
docker compose --env-file agents/doric/.env -f agents/doric/compose.yaml --profile docker up -d --build
docker compose --env-file agents/doric/.env -f agents/doric/compose.yaml logs -f docker
```

Compose starts PostgreSQL, applies database migrations, and starts the backend.
Wait for `Doric listening`, then press Ctrl+C to leave the log view; the services
keep running. The first image build can take several minutes.

<details>
<summary>macOS — run the backend locally with Docker Desktop</summary>

Start only PostgreSQL, then load the values from the file you just edited:

```sh
docker compose --env-file agents/doric/.env -f agents/doric/compose.yaml up -d --wait postgres
set -a
. ./agents/doric/.env
set +a
export DORIC_DATABASE_URL="postgresql://${DORIC_POSTGRES_USER}:${DORIC_POSTGRES_PASSWORD}@127.0.0.1:${DORIC_POSTGRES_PORT:-5432}/${DORIC_POSTGRES_DB}"
export DORIC_HOST=127.0.0.1
export DORIC_SANDBOX_PROVIDER=docker
export DORIC_SANDBOX_IMAGE=doric-sandbox:local
export DORIC_SANDBOX_SSH=false
npx nx run doric:migrate
npx nx serve doric
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
2. In **Providers**, add or edit a provider. Choose **Unified (OpenRouter)** as
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

## Things to know

- **No authentication or user access controls yet.** Anyone who can reach the
  backend can access its API, change settings, and run work. Compose binds it
  to `0.0.0.0:3000`; restrict access at the host/network level. Credential
  encryption does not provide API authentication.
- **Active development.** Interfaces and database schemas can change before
  1.0. Back up data you care about; incompatible older databases may need
  explicit recreation, and startup never resets them for you.
- **Agent actions have real effects.** Threads share their Project workspace.
  Pausing or rewinding a conversation does not undo file changes, commands, or
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
docker compose --env-file agents/doric/.env -f agents/doric/compose.yaml --profile docker down
```

For the macOS path, stop the native backend with Ctrl+C and use the same Compose
command to stop PostgreSQL. Avoid `down -v` unless you intend to delete the
Compose volumes, including the database.

## Explore further

- [Backend and API](agents/doric/README.md) — configuration, events,
  persistence, and deployment details.
- [Desktop app](app/doric/README.md) and
  [renderer](app/doric-renderer/README.md) — app development and packaging.
- [Core tools](bundles/core/README.md), [Git](bundles/git/README.md), and
  [Thread delegation](bundles/threads/README.md) — built-in agent capabilities.
- [Agent runtime](packages/agent/README.md) and
  [model integrations](packages/llms/README.md) — reusable TypeScript APIs.
- [GROUNDING.md](GROUNDING.md) — repository constraints for contributors.

Each package owns its technical README. Use `npx nx show projects` to discover
the workspace and `npx nx show project <project>` to inspect its commands.
