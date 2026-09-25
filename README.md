# Doric

Doric is a TypeScript coding agent with long-lived Project environments and
independent Thread conversations, including agent-coordinated child Threads.

## How Direct works

1. A client creates a named Project through `/projects`, without an implicit
   chat.
2. Doric reserves one isolated Docker or Firecracker sandbox for that Project
   and captures its configuration.
3. The client separately creates Threads. Each has its own history and FIFO
   queue; distinct Threads run concurrently in the shared Project sandbox,
   without a Doric-imposed Thread count or concurrency cap.
4. Each prompt gets a fresh Agent instance with the configured model, persisted
   conversation history, built-in skills, and sandbox-bound tools.
5. PostgreSQL stores Projects, Threads, messages, and per-Thread ordered events.
   Separate `/projects` and `/threads` Socket.IO namespaces expose updates;
   Thread subscriptions replay stored events before delivering live events.
6. Users and parent agents can send prompts to child Threads. Delegated results
   automatically queue a new input for the parent, without forwarding unrelated
   human follow-ups.
7. Interrupting a `promptId` preserves the Thread's queue and children.
   Terminating a Thread closes its subtree; terminating the Project closes all
   Threads and releases the sandbox once. Projects do not expire automatically.

Project/Thread follows the implemented
[architecture contract](docs/03-tdd/05-project-thread-architecture.md).
It replaces Session APIs without `/sessions` compatibility routes. The database
starts from a clean Project/Thread baseline and extends it with incremental
migrations. Session-era databases must still be explicitly recreated; there is
no automatic reset or Session data conversion.

## Start Direct locally

With an empty PostgreSQL database and Docker running:

```console
npm ci
# Set DORIC_DATABASE_URL and OPENROUTER_API_KEY in .env.
npx nx run doric:migrate
npx nx serve doric
```

Doric listens on `0.0.0.0:3000` by default. The API is unauthenticated, so keep
it on a trusted network.

See [`agents/doric/README.md`](agents/doric/README.md) for the API, event, and
persistence contracts.

## Start the desktop app

With the Direct backend listening on `127.0.0.1:3000`, start the React renderer
and Electron process together:

```console
npm run doric:dev
```

The desktop app manages named Projects and recursive Threads through a
sandboxed preload IPC boundary. Selecting a Thread opens its durable
conversation and a Markdown prompt editor that submits with Command+Enter on
macOS or Control+Enter on Windows.

## Workspace guide

Each Nx project owns a README with its public contract, usage, and development
commands.

### Agent

- [`agents/doric`](agents/doric/README.md) — Direct REST and Socket.IO host,
  PostgreSQL persistence, Project sandboxes, and independent chat Threads.

### Desktop

- [`app/doric`](app/doric/README.md) — Electron main process and secure backend
  bridge.
- [`app/doric-renderer`](app/doric-renderer/README.md) — compact shadcn/ui
  Project and recursive Thread workspace.

### Built-in bundles

- [`bundles/core`](bundles/core/README.md) — filesystem, shell, and web tools
  plus general execution skills.
- [`bundles/git`](bundles/git/README.md) — structured Git execution and focused
  Git workflow skills.
- [`bundles/threads`](bundles/threads/README.md) — child-thread delegation,
  inspection, and steering through the per-prompt host facade.

### Libraries

- [`packages/agent`](packages/agent/README.md) — provider-neutral agent loop.
- [`packages/bundle`](packages/bundle/README.md) — strict runtime loader for
  bundle manifests, tools, and skills.
- [`packages/config`](packages/config/README.md) — parser for message-carried
  agent configuration.
- [`packages/docker`](packages/docker/README.md) — Docker implementation of the
  sandbox provider contract.
- [`packages/firecracker`](packages/firecracker/README.md) — direct
  Firecracker/KVM sandbox provider.
- [`packages/jsonl`](packages/jsonl/README.md) — streaming JSON Lines storage.
- [`packages/llms`](packages/llms/README.md) — model-provider integrations.
- [`packages/messages`](packages/messages/README.md) — provider-neutral message
  storage and normalization.
- [`packages/oauth`](packages/oauth/README.md) — OAuth 2 authorization-code and
  PKCE helpers.
- [`packages/okf`](packages/okf/README.md) — Open Knowledge Format bundle
  generator.
- [`packages/sandbox`](packages/sandbox/README.md) — provider-neutral isolated
  workspace contract and helpers.
- [`packages/sandpool`](packages/sandpool/README.md) — warmed FIFO pool of
  sandbox sessions.
- [`packages/session`](packages/session/README.md) — process-local keyed session
  store.
- [`packages/tool`](packages/tool/README.md) — tool definitions, binding,
  validation, and execution.

### Standalone tools

- [`tools/okf`](tools/okf/README.md) — read-only search over workspace OKF
  bundles.

## Work in the repository

Install dependencies once, then use Nx project names from the guide above:

```console
npm ci
npx nx show projects
npx nx show project <project>
npx nx test <project>
```

The project README lists any additional build, run, typecheck, or e2e targets
and their prerequisites.

### Lint and formatting

Use the official ESLint `recommended` preset for JavaScript and
typescript-eslint `recommendedTypeChecked` plus `stylisticTypeChecked` for
workspace `.ts`, `.mts`, and `.cts` files under `src`, `tests`, and `tools`,
plus workspace `index` entrypoints. These files must be included in a workspace
tsconfig. Other TypeScript files use the untyped `recommended` preset.
These [upstream presets](https://typescript-eslint.io/users/configs/) own code
quality and TypeScript idioms; Prettier owns formatting, with
`eslint-config-prettier` applied last to prevent conflicting rules.

Import sorting is the only additional lint policy: side effects, Node built-ins,
external dependencies, workspace packages, then relative imports. There are no
local spacing rules or custom complexity, nesting, or parameter-count limits.

```console
npm run lint
npm run format:check
npm run lint:test
```

For scoped fixes, run `npx eslint --fix <files>` and
`npx prettier --write <files>`. Avoid formatting unrelated files.
CI tests the lint configuration as a blocking check. Whole-workspace lint and
formatting remain non-blocking adoption reports while existing debt is addressed;
passing the configuration tests does not mean the workspace is lint-clean.
