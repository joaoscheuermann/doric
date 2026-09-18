# Doric

Doric is a TypeScript coding agent that keeps a conversation and its working
environment alive across multiple prompts.

## How Direct works

1. A client creates a session through the REST API.
2. Doric reserves one isolated Docker or Firecracker sandbox for that session.
3. Prompts enter a FIFO queue and run one at a time in the same sandbox.
4. Each prompt gets a fresh Agent instance with the configured model, persisted
   conversation history, built-in skills, and sandbox-bound tools.
5. PostgreSQL stores configuration, sessions, messages, and the ordered event
   stream. Socket.IO replays stored events before delivering live updates.
6. The sandbox remains reserved until the session is terminated. Sessions do
   not expire automatically.

## Start Direct locally

With PostgreSQL and Docker running:

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

## Workspace guide

Each Nx project owns a README with its public contract, usage, and development
commands.

### Agent

- [`agents/doric`](agents/doric/README.md) — Direct REST and Socket.IO host,
  PostgreSQL persistence, and long-lived sandbox sessions.

### Built-in bundles

- [`bundles/core`](bundles/core/README.md) — filesystem, shell, and web tools
  plus general execution skills.
- [`bundles/git`](bundles/git/README.md) — structured Git execution and focused
  Git workflow skills.

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
