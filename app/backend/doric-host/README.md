# Doric host

The Doric host is the self-hosted backend that runs your agents. It gives each
**Project** its own sandbox (files, Git, terminal, web), runs every **Thread**
of that Project as an independent conversation, persists every prompt, event
and provider history in PostgreSQL, and exposes REST and Socket.IO so the
desktop app, scripts and other clients can drive it. Read this if you deploy
the host, integrate with its API, or change the kernel.

For the product overview and the quickest way to get everything running, start
with the [main README](../../../README.md).

## Contents

- [Concepts](#concepts)
- [Run the host](#run-the-host)
- [Configuration](#configuration)
- [How the host is built](#how-the-host-is-built)
- [Project and Thread lifecycle](#project-and-thread-lifecycle)
- [REST API](#rest-api)
- [Socket.IO](#socketio)
- [Docker deployment details](#docker-deployment-details)
- [Provider kinds](#provider-kinds)
- [Persistence and security](#persistence-and-security)
- [Storage protection](#storage-protection)
- [Validation](#validation)

## Concepts

- A **Project** owns one environment: a sandbox lease, the workspace inside
  that sandbox, and a record of the configuration in force when it was created
  ([`store/projects.ts`](../../../bundles/runtime/runtime/src/host/store/projects.ts)).
  With the Docker provider the workspace is a durable volume named after the
  Project's id, so a reacquired sandbox returns to the same files
  ([`docker/src/host/sandbox.ts`](../../../bundles/sandboxes/docker/src/host/sandbox.ts)).
  The Firecracker provider keeps no durable workspace, so a reacquired microVM
  starts again from its image
  ([`firecracker/src/host/sandbox.ts`](../../../bundles/sandboxes/firecracker/src/host/sandbox.ts)).
- A **Thread** owns an independent conversation, a FIFO prompt queue, its own
  working directory and an ordered, durable event history. A Thread may have a
  parent, so agents can delegate work to child Threads you can open and
  inspect ([`contracts/model.ts`](../../../bundles/runtime/runtime/src/contracts/model.ts)).
- Root and child Threads of one Project share its sandbox, so its files and
  processes; they are not isolated from each other
  ([`domain/runner.ts`](../../../bundles/runtime/runtime/src/host/domain/runner.ts)).
- Threads have no count, concurrency or depth cap: different Threads run at the
  same time. A Thread the reader opens hangs from the Project or from a root
  Thread; an agent nests child Threads at any depth
  ([`domain/runner.ts`](../../../bundles/runtime/runtime/src/host/domain/runner.ts)).
- Sandboxes are bounded: each provider's pool holds at most 10 sandboxes, and
  an acquisition beyond that waits, in arrival order, for capacity
  ([`docker/src/host/sandbox.ts`](../../../bundles/sandboxes/docker/src/host/sandbox.ts),
  [`firecracker/src/host/sandbox.ts`](../../../bundles/sandboxes/firecracker/src/host/sandbox.ts),
  [`sandpool.ts`](../../../packages/sandpool/src/lib/sandpool.ts)).

How Projects and Threads behave across the bundles that implement them is
described in the feature doc
[Projects and Threads](../../../docs/features/projects-and-threads.md).

## Run the host

### With Docker Compose

[`compose.yaml`](compose.yaml) runs the host with PostgreSQL. The deploy
credentials, the PostgreSQL password included, live only in
`app/backend/doric-host/.env`: copy [`.env.example`](.env.example) there and
fill in its empty values. The root [`.gitignore`](../../../.gitignore) ignores
that file, so it is never committed. Compose reads it to fill in the variables
of `compose.yaml` and hands the values to the containers as environment
variables. The image build does not exclude it:
[`.dockerignore`](../../../.dockerignore) excludes `.env` and `.env.*` only at
the repository root, and [`.Dockerfile`](.Dockerfile) copies `app/` whole, so an
image built while the file exists contains it.

`.env.example` holds these entries:

- `DORIC_POSTGRES_USER=doric`: the PostgreSQL role Compose creates and the
  host connects as.
- `DORIC_POSTGRES_DB=doric`: the database Compose creates.
- `DORIC_POSTGRES_PASSWORD`, empty: the role's password, for instance from
  `openssl rand -hex 24`.
- `DORIC_CREDENTIAL_KEY`, empty: the key that encrypts stored credential
  secrets, from `openssl rand -base64 32`; keep it across restarts.
- `DORIC_SANDBOX_DOCKER_SOCKET=true`: shares the host's Docker socket with
  every Project sandbox; see [the sandbox image](#the-sandbox-image).

Build the sandbox image first (see [The sandbox image](#the-sandbox-image)),
then:

```sh
cp app/backend/doric-host/.env.example app/backend/doric-host/.env   # then edit it
docker build -f app/backend/doric-host/.sandbox.Dockerfile -t doric-sandbox:local app/backend/doric-host
cd app/backend/doric-host
docker compose --profile docker build
docker compose --profile docker up -d
```

Run from this directory, Compose reads `.env` on its own and names the project
`doric-sandbox`. From the repository root, `npm run doric:docker:build` runs the
same `up` with `--build`, `--env-file app/backend/doric-host/.env` and the
project name `doric` ([`package.json`](../../../package.json)). The project
name prefixes the volumes, so the two commands keep separate databases (and
separate `firecracker-state` and `firecracker-cache` volumes); use one of them
consistently.

Compose defines these services ([`compose.yaml`](compose.yaml)):

- `postgres`: PostgreSQL 18.4 (`postgres:18.4-alpine3.24`, pinned by digest).
  Its volume `postgres-data` is mounted at `/var/lib/postgresql`, its port is
  published on `127.0.0.1:${DORIC_POSTGRES_PORT:-5432}`, and a `pg_isready`
  health check runs every 2 s, up to 30 times.
- `migrate`: a one-shot
  `npx prisma migrate deploy --config app/backend/doric-host/prisma.config.ts`,
  built from the `agent-runtime` target of [`.Dockerfile`](.Dockerfile). It
  starts once `postgres` is healthy and is never restarted.
- `docker`, profile `docker`: the host, built from the `docker-runtime`
  target, with `DORIC_SANDBOX_PROVIDER=docker`, the host network, the
  `NET_ADMIN` capability and the host's `/var/run/docker.sock`.
- `firecracker`, profile `firecracker`: the host, built from the final
  `runtime` target,
  with `DORIC_SANDBOX_PROVIDER=firecracker`, the host network, privileged
  mode, `/dev/kvm`, `/dev/net/tun`, the cgroup filesystem read-write and the
  volumes `firecracker-state` and `firecracker-cache`.

Either host service starts only after `postgres` is healthy and `migrate` has
completed successfully. Both reach PostgreSQL at
`127.0.0.1:${DORIC_POSTGRES_PORT:-5432}` with the `.env` credentials, bind
`0.0.0.0`, mount `postgres-data` read-only at `/var/lib/doric/postgresql` and
set `DORIC_STORAGE_PATH` to it, default `DORIC_SANDBOX_SSH` to `true`, and pass
`DORIC_CREDENTIAL_KEY` on. The `docker` service also passes
`DORIC_SANDBOX_IMAGE` (default `doric-sandbox:local`),
`DORIC_SANDBOX_DOCKER_SOCKET` (default `false`), `DORIC_SANDBOX_CPUS` and
`DORIC_SANDBOX_MEMORY_MIB` (empty keeps the provider's defaults); the
`firecracker` service sets none of them, so it runs `node:22-bookworm`
([Configuration](#configuration)).

Confirm the deploy from the host log (`Bundles loaded` reports the bundle, tool
and skill counts, then `Doric listening`) and from `GET /projects`.

### Natively

Run PostgreSQL yourself (or only the Compose `postgres` service), point
`DORIC_DATABASE_URL` at it, apply the migrations, and serve the host:

```sh
export DORIC_DATABASE_URL=postgresql://USER:PASSWORD@127.0.0.1:5432/DB
npx nx run doric-host:migrate
npx nx serve doric-host
```

The targets are defined in [`project.json`](project.json):

- `build` compiles `src/` into `dist/`, after `build-bundles` and the build of
  every project it depends on.
- `build-bundles` builds every Nx project tagged `type:bundle`, then stages
  every bundle into `dist/bundles`; it is never cached.
- `migrate` runs `prisma migrate deploy` with
  [`prisma.config.ts`](prisma.config.ts), whose schema and migrations are the
  `postgres` bundle's, against `DORIC_DATABASE_URL`, or
  `postgresql://doric:doric@127.0.0.1:5432/doric` when it is unset.
- `serve` and `run` build, then run
  `node app/backend/doric-host/dist/src/index.js`.
- `test` compiles the host and its tests into `dist-tests/` and runs them with
  `node --test`; see [Validation](#validation).

Startup never applies migrations.

Run natively, the host process is also the sandbox provider's host, so it
needs what that provider needs. The sandbox package checks these when it
provisions a sandbox, not at startup, so a missing one makes the first
acquisition fail and the Project end `failed` with `sandbox_acquisition_failed`
([On-demand sandboxes](#on-demand-sandboxes)):

- **Docker**
  ([`packages/docker-sandbox`](../../../packages/docker-sandbox/README.md),
  [`host.ts`](../../../packages/docker-sandbox/src/lib/host.ts),
  [`docker.ts`](../../../packages/docker-sandbox/src/lib/docker.ts)):
  - a local Docker daemon, reached through `DOCKER_HOST` or
    `/var/run/docker.sock` ([Configuration](#configuration));
  - on Linux, the host network namespace and `nftables` with `CAP_NET_ADMIN`,
    or provisioning fails with
    `Docker egress requires nftables CAP_NET_ADMIN access`; on macOS and
    Windows, Docker Desktop's own network path is used instead;
  - with `DORIC_SANDBOX_SSH=true`, `ssh-keygen` and an executable static
    Dropbear at `/opt/doric/firecracker/dropbearmulti`, or provisioning fails
    with `Docker SSH requires pinned Dropbear: <path>`.
- **Firecracker**
  ([`packages/firecracker-sandbox`](../../../packages/firecracker-sandbox/README.md)):
  Linux with read-write `/dev/kvm` and `/dev/net/tun`, cgroup v2, IPv4
  forwarding, `nftables` with network-admin access, the pinned Firecracker,
  jailer, kernel, initramfs and Dropbear assets under `/usr/local/bin` and
  `/opt/doric/firecracker`, the OCI, ext4, network and SSH command-line tools
  its preflight checks, and writable state and cache directories. The
  `firecracker` Compose profile packages all of these.

## Configuration

HTTP and Socket.IO share one listener, `0.0.0.0:3000` by default. The kernel
reads the listener, bundle, composition and log variables
([`src/index.ts`](src/index.ts),
[`src/lib/bundles/boot.ts`](src/lib/bundles/boot.ts)); the bundles read the
others from the same environment, which their generation process inherits.

- `DORIC_HOST` (default `0.0.0.0`): address the HTTP/Socket.IO listener binds
  ([`src/index.ts`](src/index.ts)).
- `DORIC_PORT` (default `3000`): port of that listener, parsed with
  `Number.parseInt`; a value whose leading digits are not a port 0–65535 fails
  startup at `network_binding`.
- `DORIC_DATABASE_URL` (no default): PostgreSQL connection URL. Required: an
  empty or missing URL fails startup at `database_client`, and an unreachable
  database fails at its first query, at `credential_activation`
  ([`postgres/src/prisma.ts`](../../../bundles/foundation/postgres/src/prisma.ts),
  [`postgres/src/host/start.ts`](../../../bundles/foundation/postgres/src/host/start.ts)).
- `DORIC_CREDENTIAL_KEY` (no default): 32 bytes, base64-encoded, that encrypt
  stored credential secrets. A set but malformed key always fails startup at
  `credential_activation`, with
  `DORIC_CREDENTIAL_KEY must be 32 base64-encoded bytes.` A missing key fails
  startup there only once a stored credential holds a secret, and it fails every attempt to store a secret
  (`DORIC_CREDENTIAL_KEY is required to store a credential secret.`)
  ([`postgres/src/host/secrets/backend.ts`](../../../bundles/foundation/postgres/src/host/secrets/backend.ts),
  [`postgres/src/host/secrets/envelope.ts`](../../../bundles/foundation/postgres/src/host/secrets/envelope.ts)).
- `DORIC_STORAGE_PATH` (default: the current directory): filesystem the
  [storage protection](#storage-protection) measures
  ([`postgres/src/host/storage/health.ts`](../../../bundles/foundation/postgres/src/host/storage/health.ts)).
  Compose sets `/var/lib/doric/postgresql`.
- `DORIC_SANDBOX_PROVIDER` (default `docker`): `docker` or `firecracker`; any
  other value selects `docker`. It applies only when `DORIC_COMPOSITION` is
  unset; a composition named by `DORIC_COMPOSITION`, even the shipped file,
  is booted as written and names its provider in `enabled`
  ([`src/lib/bundles/boot.ts`](src/lib/bundles/boot.ts)).
- `DORIC_SANDBOX_IMAGE` (default `node:22-bookworm`): image every Project
  sandbox runs, with either provider. The provider pulls it only when it is
  absent locally, so a local tag that was never built fails the pull, and the
  Project ends `failed` with `sandbox_acquisition_failed`. Compose's `docker`
  profile defaults it to `doric-sandbox:local`.
- `DORIC_SANDBOX_SSH` (default off): exactly `true` adds loopback-bound user
  SSH access to the active sandbox. Compose profiles default it to `true`, and
  so do the `docker-runtime` and `runtime` images ([`.Dockerfile`](.Dockerfile)).
- `DORIC_SANDBOX_DOCKER_SOCKET` (default off): exactly `true` mounts the host's
  Docker socket into every Docker sandbox. See
  [the sandbox image](#the-sandbox-image).
- `DORIC_SANDBOX_CPUS` (default `4`): CPUs each Docker sandbox may use. Empty
  keeps the default; a value that is not a whole positive number fails the
  activation of the `docker` bundle
  ([`docker/src/host/sandbox.ts`](../../../bundles/sandboxes/docker/src/host/sandbox.ts)).
- `DORIC_SANDBOX_MEMORY_MIB` (default `2048`): memory each Docker sandbox may
  use, in MiB, with the same rule as `DORIC_SANDBOX_CPUS`.
- `DORIC_BUNDLES_PATH` (default: the staged `app/backend/doric-host/dist/bundles`):
  root of the installed bundles.
- `DORIC_COMPOSITION` (default [`composition.json`](composition.json)):
  composition to boot. A custom one is booted as written.
- `DORIC_LOG_FILE` (default `doric.log`): file that receives the debug-level
  log; the console shows info and above.
- `DOCKER_HOST` (default `/var/run/docker.sock`): the Docker daemon the Docker
  provider reaches; a `unix://` URL or an absolute socket path is used, any
  other value falls back to the default
  ([`packages/docker-sandbox/src/lib/mapping.ts`](../../../packages/docker-sandbox/src/lib/mapping.ts)).

Every Docker sandbox also gets a 4096 MiB disk. A Firecracker sandbox has fixed
resources, 1 CPU, 512 MiB of memory and a 4096 MiB disk
([`firecracker/src/host/sandbox.ts`](../../../bundles/sandboxes/firecracker/src/host/sandbox.ts)).
Both providers give a sandbox egress networking with the DNS server `1.1.1.1`,
and each pool tries to create a sandbox at most 3 times
(`maxCreateAttempts`) before it fails the waiting acquisitions
([`sandpool.ts`](../../../packages/sandpool/src/lib/sandpool.ts)).

Compose also reads `DORIC_POSTGRES_USER`, `DORIC_POSTGRES_PASSWORD`,
`DORIC_POSTGRES_DB` and `DORIC_POSTGRES_PORT` (default `5432`) from the
environment file to start PostgreSQL and build `DORIC_DATABASE_URL`
([`compose.yaml`](compose.yaml)).

## How the host is built

The host is a small kernel. Everything a user sees — Projects, Threads, tools,
providers, sandboxes, routes and the desktop UI — comes from **bundles** the
kernel loads through the `bundle` platform package
([`packages/bundle`](../../../packages/bundle/README.md)).

```text
src/
├── index.ts            composition root: logger, listener, startup stages, bundle boot, shutdown
└── lib/
    ├── bridge/
    │   ├── catalog.ts     the distribution members of `doric.catalog/v1`
    │   └── socket.ts      the desktop bridge namespace `/doric/bridge`
    ├── bundles/
    │   └── boot.ts        bundle paths, composition, structural checks
    └── socket-buffer.ts   the largest Socket.IO message the host accepts
```

The kernel owns one Express app, one Node HTTP server and one Socket.IO server
on it, and hands all three to the bundles as their network
([`src/index.ts`](src/index.ts)); the `transport` bundle registers the REST
routes and Socket.IO namespaces on them
([`transport/src/host/index.ts`](../../../bundles/foundation/transport/src/host/index.ts)),
and the `screen-relay` bundle its `/screen/<token>/` upgrades
([`screen-relay/src/host/relay.ts`](../../../bundles/features/screen-relay/src/host/relay.ts)).
Two Socket.IO settings follow from that:

- `destroyUpgrade` is off, so Socket.IO never ends an HTTP upgrade it does not
  own, such as a relayed screen handshake; Socket.IO handles `/socket.io/`
  only.
- `maxHttpBufferSize` is 8,039,084 bytes: the base64 size of the largest image
  attachment the runtime keeps (6,990,508 bytes) plus 1 MiB for the envelope
  around it, because a desktop call carries an attachment whole
  ([`src/lib/socket-buffer.ts`](src/lib/socket-buffer.ts)). A larger message
  drops the connection.

### Bundles and composition

The host reads the installed bundles below `DORIC_BUNDLES_PATH` and the
composition at `DORIC_COMPOSITION`
([`src/lib/bundles/boot.ts`](src/lib/bundles/boot.ts)). The shipped
[`composition.json`](composition.json):

- names `core` as the core and enables these 32 bundles, in this order:
  `transport`, `postgres`, `core`, `host-config`, `files`, `web`, `git`,
  `threads`, `terminal`, `usage`, `resources`, `screen`, `screen-relay`,
  `runtime`, `default`, `openai`, `openrouter`, `codex`, `claude`,
  `claude-login`, `docker`, `notifications`, `layout`, `account`,
  `workspace`, `settings`, `chat`, `history`, `comments`, `openui`,
  `papercraft` and `mcp`;
- chooses `postgres` as the provider of `storage.backend/v1` and
  `secrets.backend/v1`;
- names the `resident` bundles that run in the kernel process itself
  (`host-config`, `transport`, `screen-relay`);
- requires the contracts `runtime/v2`, `executor/v1`, `sandbox/v1`,
  `models/v1` and `host-config/v1` and the bundle `transport`: the host does
  not serve without an active provider of each
  ([Startup and failures](#startup-and-failures));
- offers the `sandbox` alternative: `DORIC_SANDBOX_PROVIDER` picks `docker`,
  the default and the one `enabled` lists, or `firecracker`, which then takes
  the place of `docker` in `enabled`.

The kernel runs the foundation, the core, the embedded bundles and the
resident bundles in its own process, and every other installed bundle in a
generation process it forks, which inherits its environment
([`src/lib/bundles/boot.ts`](src/lib/bundles/boot.ts)). How generations are
started, switched and respawned is described in
[process-isolation.md](../../../docs/architecture/bundles/process-isolation.md),
and the composition format in
[composition-and-distribution.md](../../../docs/architecture/bundles/composition-and-distribution.md).

A custom `DORIC_COMPOSITION` is booted as written. A bundle it leaves out is
absent, and every bundle that requires a contract only the missing bundle
provides is quarantined. Leaving out `workspace` quarantines `files`, `git`,
`terminal`, `resources`, `mcp`, `screen` and `usage`, each of which requires a
`workspace.*` contract, and `papercraft`, which requires `files/v1` (their
`manifest.json` files under [`bundles/features/`](../../../bundles/features)).
A bundle no other bundle requires, such as `account`, is simply absent, and
nothing reports it. A composition whose `required` entry names a contract or
a bundle that is not active does not start.

What each bundle the host composes does, in one line; each bundle's README is
the home of its contracts and behavior.

Foundation:

- [`transport`](../../../bundles/foundation/transport/README.md) registers
  every REST route and Socket.IO namespace on the kernel's listener through
  `doric.network/v1`; the kernel registers no product route of its own, only
  the [desktop bridge](#the-desktop-bridge).
- [`postgres`](../../../bundles/foundation/postgres/README.md) provides
  `storage.backend/v1` and `secrets.backend/v1`, owns the Prisma schema and
  migrations under
  [`bundles/foundation/postgres/prisma/`](../../../bundles/foundation/postgres/prisma),
  and creates the process's one PostgreSQL client on first use
  ([`postgres/src/host/database.ts`](../../../bundles/foundation/postgres/src/host/database.ts)).
- [`core`](../../../bundles/foundation/core/README.md) provides the basic
  services, among them `hooks/v1`, `log/v1`, `tools/v1`, `skills/v1`,
  `settings/v1`, `secrets/v1`, `storage/v1`, `events/v1` and `models/v1`
  ([`core/manifest.json`](../../../bundles/foundation/core/manifest.json)); the
  loader registers each bundle's `skills/*/SKILL.md` with `skills/v1`, in
  lexical folder order
  ([`loader/skills.ts`](../../../packages/bundle/src/loader/skills.ts)).
- [`host-config`](../../../bundles/foundation/host-config/README.md) owns the
  configuration (the `settings/v1` space `host-config.configuration/v1`) and
  provides `host-config/v1`, the active configuration and the `PUT /config`
  pipeline; it names the credentials the configuration references, so deleting
  one is refused
  ([`host-config/src/host/configuration.ts`](../../../bundles/foundation/host-config/src/host/configuration.ts)).

Runtime:

- [`runtime`](../../../bundles/runtime/runtime/README.md) owns Projects,
  Threads, their queues, the sandbox leases, recovery and the prompt runner,
  and provides `runtime/v2`, `runtime.threads/v1`, `runtime.workspace/v1`,
  `runtime.lease/v1` and the other `runtime.*` contracts. The contracts a tool
  calls forward each call to the per-prompt `Host` facade, bound to the calling
  prompt's scope only while that prompt runs
  ([`services/workspace.ts`](../../../bundles/runtime/runtime/src/host/services/workspace.ts)).
- [`default`](../../../bundles/runtime/default/README.md) provides
  `executor/v1`, the default agent: system prompt, skills, tools, model
  resolution and provider history.

Sandboxes (one of the two, by `DORIC_SANDBOX_PROVIDER`), each providing
`sandbox/v1`:

- [`docker`](../../../bundles/sandboxes/docker/README.md): one
  durable-workspace container per Project.
- [`firecracker`](../../../bundles/sandboxes/firecracker/README.md): one
  microVM per Project.

Model providers, each providing a `models.provider/v1` kind:

- [`openai`](../../../bundles/providers/openai/README.md): OpenAI Responses.
- [`openrouter`](../../../bundles/providers/openrouter/README.md): OpenRouter,
  with its live catalog and structured-output repair.
- [`codex`](../../../bundles/providers/codex/README.md): Codex, internal and not
  advertised.
- [`claude`](../../../bundles/providers/claude/README.md): Claude Code
  subscription login.

Features:

- [`files`](../../../bundles/features/files/README.md): the agent's file tools
  and the desktop's file views, over `runtime.workspace/v1` and
  `runtime.lease/v1`.
- [`web`](../../../bundles/features/web/README.md): the agent's web research.
- [`git`](../../../bundles/features/git/README.md): Git repository tools and
  the desktop's changes, over `runtime.workspace/v1` and `runtime.lease/v1`.
- [`threads`](../../../bundles/features/threads/README.md): the delegation
  tools `thread-spawn`, `thread-list`, `thread-get`, `thread-events`,
  `thread-send`, `thread-restart`, `thread-interrupt` and `thread-terminate`,
  over `runtime.threads/v1` only
  ([`threads/src/host/index.ts`](../../../bundles/features/threads/src/host/index.ts)).
- [`terminal`](../../../bundles/features/terminal/README.md): tracked shell
  commands and manual terminal sessions, `terminal/v1`.
- [`usage`](../../../bundles/features/usage/README.md): Thread usage and cost,
  `usage/v1`.
- [`resources`](../../../bundles/features/resources/README.md): the host
  machine and Project sandbox resource monitor, `resources/v1`.
- [`screen`](../../../bundles/features/screen/README.md): the xpra HTML5
  screen of a Project's sandbox.
- [`screen-relay`](../../../bundles/features/screen-relay/README.md): the
  `/screen/<token>/` relay of every Project screen, on the host's own origin.
- [`claude-login`](../../../bundles/features/claude-login/README.md): the
  in-app Claude Code sign-in, stored as the `Claude` API token credential.
- [`comments`](../../../bundles/features/comments/README.md): anchored
  comments and their durable events, `comments/v1`.
- [`openui`](../../../bundles/features/openui/README.md): UI answers in the
  conversation, the question form and its answers.
- [`papercraft`](../../../bundles/features/papercraft/README.md): live
  previews of a Project's code as conversation nodes.
- [`mcp`](../../../bundles/features/mcp/README.md): MCP servers per Project,
  their tools for its prompts and OAuth sign-in, `mcp/v1`.

Desktop (client parts the desktop downloads through the
[desktop bridge](#the-desktop-bridge)):

- [`notifications`](../../../bundles/desktop/notifications/README.md): a
  native notice when a prompt finishes outside the reader's view.
- [`layout`](../../../bundles/desktop/layout/README.md): the workspace window's
  frame and its slots.
- [`account`](../../../bundles/desktop/account/README.md): the reader's
  account status and menu, and About.
- [`workspace`](../../../bundles/desktop/workspace/README.md): Projects,
  Threads and the selection the window shows.
- [`settings`](../../../bundles/desktop/settings/README.md): the settings
  window.
- [`chat`](../../../bundles/desktop/chat/README.md): the transcript, the
  composer and the execution picker.
- [`history`](../../../bundles/desktop/history/README.md): local per-Thread
  conversation history snapshots.

### Startup and failures

Startup runs in named stages; the kernel names its own and each bundle names
the stage of its start step through `doric.startup/v1`
([`src/index.ts`](src/index.ts)). In order:

1. `bootstrap`: the kernel reads the composition and applies the chosen
   alternatives, then logs `Doric starting` with `host`, `port` and
   `alternatives` ([`src/lib/bundles/boot.ts`](src/lib/bundles/boot.ts)). A
   composition it cannot read is handed to the platform as a path, which
   refuses it at `bundle_load`.
2. `bundle_load`: it logs `Loading bundles`, starts the platform and waits
   until the first generation is active or failed, checks the `required`
   contracts and bundles, and logs `Bundles loaded` with `bundleCount`,
   `skillCount` and `toolCount`. Activating the bundles opens no database.
3. The bundles' start steps (`onHostStartHook`), in activation order, each at
   its own stage:
   - `database_client`: the `core` bundle's start step connects
     `storage.backend/v1`, and the `postgres` bundle creates its client there,
     so an empty or missing `DORIC_DATABASE_URL` fails here. It logs
     `Initializing PostgreSQL client` and then `PostgreSQL client initialized`.
     It also refuses a database in which the tables `project`, `thread` and
     `thread_event` all exist and one of them holds a row; a check query that
     fails is ignored
     ([`postgres/src/host/start.ts`](../../../bundles/foundation/postgres/src/host/start.ts),
     [`postgres/src/host/database.ts`](../../../bundles/foundation/postgres/src/host/database.ts)).
   - `credential_activation`: `core` reads the stored credentials once through
     `secrets/v1`, so an unreachable database or an unusable
     `DORIC_CREDENTIAL_KEY` fails here
     ([`core/src/host/secrets/activation.ts`](../../../bundles/foundation/core/src/host/secrets/activation.ts)).
   - `configuration_activation`: `host-config` reads the stored configuration,
     prepares its model providers and logs `Doric configuration activated`
     ([`host-config/src/host/configuration.ts`](../../../bundles/foundation/host-config/src/host/configuration.ts)).
   - `sandbox_pool`: the sandbox provider logs its pool's settings
     ([`docker/src/host/start.ts`](../../../bundles/sandboxes/docker/src/host/start.ts),
     [`firecracker/src/host/start.ts`](../../../bundles/sandboxes/firecracker/src/host/start.ts)).
   - `workspace_reconciliation`: the runtime reconciles the stored Projects and
     Threads and logs `Workspace reconciled`
     ([Host restarts](#host-restarts),
     [`runtime/src/host/lifecycle.ts`](../../../bundles/runtime/runtime/src/host/lifecycle.ts)).

   After the start steps the platform reads the storage identity, still within
   `platform.start()`; a failure there is reported at the last bundle's stage.

4. The kernel installs the [desktop bridge](#the-desktop-bridge), and the
   bundles hear that the host is ready (`platform.ready()`) before it accepts
   any request.
5. `network_binding`: it logs `Binding HTTP listener`, listens on
   `DORIC_HOST:DORIC_PORT`, logs `Doric listening` and enters the stage
   `ready`.

A failure in any stage logs `Doric failed to start` at level `fatal` with only
the `stage` field, and the process exits with code 1
([`src/index.ts`](src/index.ts)). The error itself is not logged: a start step
that throws makes `platform.start()` reject without a log line
([`kernel.ts`](../../../packages/bundle/src/process/kernel.ts)), and a
`network_binding` failure, such as a port in use, is not logged either. The
last line before `Doric failed to start` shows how far startup got, for
instance `Initializing PostgreSQL client` with no
`PostgreSQL client initialized`. Only a recovery-mode failure logs its reason
(`Bundle recovery mode`).

- A bundle that fails validation or activation is **quarantined**, logged as
  `Bundle quarantined` with its reasons, and the others keep serving. The
  desktop splash lists quarantined bundles and can disable one, which writes
  `composition.overrides.json` beside the active composition
  ([splash-and-recovery.md](../../../docs/architecture/bundles/splash-and-recovery.md)).
- A core that cannot activate, or a composition whose `required` contracts or
  bundles are not all active, puts the host in **recovery mode**. The host has
  no recovery surface of its own: it logs `Bundle recovery mode` with the
  reason, stops the platform, and startup fails at the `bundle_load` stage
  ([`src/lib/bundles/boot.ts`](src/lib/bundles/boot.ts)). A quarantined
  sandbox provider, for instance after an invalid `DORIC_SANDBOX_CPUS`, leaves
  `sandbox/v1` without a provider and so takes this path.
- A required provider lost after boot, when a generation becomes active
  without it, logs `Bundle recovery mode` and exits the process with code 1, so
  a supervisor restarts the host.

### Shutdown

`SIGINT` or `SIGTERM` closes the host once, in this order
([`src/index.ts`](src/index.ts)):

1. It stops watching the required providers.
2. It closes the Socket.IO server and the HTTP listener.
3. `platform.shutdown()` runs the bundles' stop steps (`onHostStopHook`) in
   reverse activation order, while every bundle is still active; the runtime's
   step suspends every live Project ([Host restarts](#host-restarts)).
4. `platform.stop()` deactivates the transport, the generations, the core and,
   last, the storage.

### The desktop bridge

The kernel's one Socket.IO namespace is `/doric/bridge`, on the same server
([`src/lib/bridge/socket.ts`](src/lib/bridge/socket.ts)). Through it the
desktop calls the contracts of the host's bundles. Each message is emitted
under its `kind` and carries the whole envelope message, whose shapes are
defined in
[`envelope/messages.ts`](../../../packages/bundle/src/runtime/envelope/messages.ts)
and described in
[Envelope RPC](../../../docs/architecture/bundles/process-isolation.md#envelope-rpc);
the bridge's place in distribution is described in
[composition-and-distribution.md](../../../docs/architecture/bundles/composition-and-distribution.md#the-contract-doriccatalogv1).
Every request carries `caller`, `trace`, `deadline` (epoch milliseconds, `0`
for none), `generation` and an optional `scope`.

- `call { id, contract, method, input, … }`: the host calls the method in the
  kernel's active view as principal `doric`, waiting for a respawning
  generation's provider first, and answers `result { id, ok: true, output }`
  or `result { id, ok: false, error: { code, message, details? } }`.
- `cancel { id }`: the host aborts that call's signal; the call still answers
  with its `result`.
- `subscribe { id, contract, method, input, … }`: the host opens a stream
  method, emits each item as `event { id, values: [item] }`, and the end of
  the stream or its failure as `end { id, error? }`.
- `unsubscribe { id }`: the host disposes that stream without an `end`.

The rules of every request:

- Only the methods the active provider's contract exposes to the desktop are
  served; any other answers `unavailable` with the message
  `<contract> <method> is not available to the desktop.` The methods and scope
  keys a window may use are listed in
  [`tests/bridge-exposure.snapshot.json`](tests/bridge-exposure.snapshot.json).
- An input whose schema is a tuple must be an array, which is spread as the
  method's arguments; otherwise the call answers, or the stream ends with,
  `invalid_input` and the message
  `Invalid input for <contract> <method>: expected the argument tuple.` Any
  other input is passed as the one argument.
- `call` on a stream method answers `invalid_input` with the message
  `<contract> <method> is a stream; subscribe to it.`, and `subscribe` on a
  method that is not a stream ends with `invalid_input` and the message
  `<contract> <method> is not a stream.`
- A message that does not parse is logged as
  `Refused a malformed host bridge message`; a malformed `call` or `subscribe`
  with a string `id` is answered with `invalid_input`
  (`Malformed call message.` or `Malformed subscribe message.`).
- A disconnect aborts every open call and disposes every open stream.

The kernel also provides the distribution members of `doric.catalog/v1`, which
the desktop reads through the bridge to download, verify and resolve the
client and desktop parts of a host generation
([`src/lib/bridge/catalog.ts`](src/lib/bridge/catalog.ts)):

- `distribution` answers the generation's `DistributionCatalog`: `generation`;
  `hostBoot`, a random UUID each host process draws when it starts its bundles
  ([`src/lib/bundles/boot.ts`](src/lib/bundles/boot.ts)), which with
  `generation` names a host generation; `platformVersion`; the `composition`;
  the `storage` identity once resolved; `host`, the live `CatalogSnapshot`;
  and `bundles`, each with its files (`path`, `sha256`, `size`) and its live
  state and reasons. A bundle embedded in the kernel has no directory, so its
  contract documents are served from memory. The full shape is described in
  [composition-and-distribution.md](../../../docs/architecture/bundles/composition-and-distribution.md#the-contract-doriccatalogv1).
- `artifact({ sha256 })` answers `{ sha256, base64 }` for a file a retained
  generation lists, after checking its hash again, and otherwise fails with
  `not_found`.
- `watch` emits `{ generation }` each time another generation becomes active;
  a respawn of the same generation emits nothing.

## Project and Thread lifecycle

### States

The [`runtime`](../../../bundles/runtime/runtime/README.md) bundle owns this
lifecycle, and its README is the home of the contracts below
([`domain/service.ts`](../../../bundles/runtime/runtime/src/host/domain/service.ts),
[`domain/runner.ts`](../../../bundles/runtime/runtime/src/host/domain/runner.ts)).
A Project's state is `queued`, `ready`, `cancelling`, `cancelled` or `failed`;
a Thread's adds `running`. `cancelled` and `failed` are terminal
([`contracts/model.ts`](../../../bundles/runtime/runtime/src/contracts/model.ts)).

- Create a Project first, then create its Threads explicitly. Project creation
  does not create a conversation.
- A new Project is `queued` and starts acquiring its sandbox at once, with its
  id as the sandbox identity. It becomes `ready` once the sandbox is acquired;
  an acquisition that fails ends it `failed` with the error code
  `sandbox_acquisition_failed`.
- A new Thread is `queued`, in `/workspace`, or, for a child, in its parent's
  current directory. It becomes `ready` at once when its Project holds a
  sandbox, and otherwise when the sandbox arrives
  ([`store/threads.ts`](../../../bundles/runtime/runtime/src/host/store/threads.ts)).
- Threads process prompts through `ready -> running -> ready`.
- Termination goes `cancelling -> cancelled`, or `cancelling -> failed` when it
  carries an error code, and stays terminal.

### Stop, rewind, terminate, delete

- **Stop** (`POST /threads/:id/interrupt`) closes a durable per-Thread dispatch
  gate and aborts the active prompt. The prompt finishes with
  `prompt.finished` `status: cancelled` and `reason: interrupted`, keeping the
  history it wrote. Queued inputs stay accepted but wait until
  `POST /threads/:id/queue/resume` reopens the gate. Repeated stops are
  idempotent, the gate survives a host restart, and a stop never interrupts
  child Threads
  ([`domain/runner.ts`](../../../bundles/runtime/runtime/src/host/domain/runner.ts)).
- **Rewind** replaces an edited turn. It requires an idle Thread with an empty
  queue (`busy` otherwise), discards that turn and every later one, and
  enqueues the replacement as a new prompt. A Thread an agent opened cannot be
  rewound (`forbidden`), and a Project for which the process holds no runtime
  answers `inactive`
  ([`domain/service.ts`](../../../bundles/runtime/runtime/src/host/domain/service.ts),
  [`domain/runner.ts`](../../../bundles/runtime/runtime/src/host/domain/runner.ts));
  how the route maps these answers is in [Request rules](#request-rules).
- **Terminating a Thread** cancels its entire subtree but leaves other Threads
  and the Project environment available.
- **Terminating a Project** cancels all its Threads before releasing its lease.
  A lease that does not release ends the Project `failed` with
  `sandbox_release_failed`
  ([`domain/service.ts`](../../../bundles/runtime/runtime/src/host/domain/service.ts),
  [`domain/runner.ts`](../../../bundles/runtime/runtime/src/host/domain/runner.ts)).
- Cancellation is cooperative: it aborts the running prompts and does not undo
  sandbox changes.
- Projects do not expire automatically: nothing in the runtime ends an idle
  Project. Terminate unused Projects to release their environments
  ([`domain/service.ts`](../../../bundles/runtime/runtime/src/host/domain/service.ts),
  [`domain/runner.ts`](../../../bundles/runtime/runtime/src/host/domain/runner.ts)).
- **Physical deletion** of a Thread requires its whole subtree to be terminal,
  and of a Project requires the Project and every Thread to be terminal;
  otherwise it answers `active`. A Thread an agent opened is deleted only once
  it is archived (`forbidden` otherwise). Deleting a Project removes its
  records and then discards its workspace through `sandbox/v1`: the Docker
  provider removes the durable volume, the Firecracker provider has nothing to
  remove. A discard that fails is logged as `Project workspace discard failed`
  and the deletion stands
  ([`store/projects.ts`](../../../bundles/runtime/runtime/src/host/store/projects.ts),
  [`store/threads.ts`](../../../bundles/runtime/runtime/src/host/store/threads.ts),
  [`domain/service.ts`](../../../bundles/runtime/runtime/src/host/domain/service.ts)).

### Host restarts

A Project survives a host restart. A host stop is not a termination
([`lifecycle.ts`](../../../bundles/runtime/runtime/src/host/lifecycle.ts),
[`domain/service.ts`](../../../bundles/runtime/runtime/src/host/domain/service.ts),
[`store/threads.ts`](../../../bundles/runtime/runtime/src/host/store/threads.ts),
[`store/projects.ts`](../../../bundles/runtime/runtime/src/host/store/projects.ts)):

1. The stop releases the lease, writes the Project back as `queued` (it needs a
   sandbox again) and its non-terminal Threads as `ready`, and _pauses_ the
   running prompt. The prompt stays unfinished, with
   `prompt.paused { reason: 'host_stopped' }`, so the next boot takes it up
   again. A lease that does not release leaves the Project `queued` with
   `sandbox_release_failed`. After the stop, creating a Project fails with
   `Doric is shutting down.`
2. The next boot reconciles the Threads: a prompt whose run started but never
   recorded a pause gets `prompt.paused { reason: 'host_restarted' }`, because
   the restart is what interrupted it, and a non-terminal Thread becomes
   `ready`, with no active prompt and no error code other than `storage_low`.
3. It reconciles the Projects: a non-terminal Project becomes `queued`, with no
   error code. A Thread or Project a crash left `cancelling` becomes
   `cancelled` instead: reviving it would resurrect work the reader stopped.
4. It takes up the prompts the host owes: every unfinished prompt that is not
   superseded (a paused prompt is superseded by the next input the reader
   sends straight to the Thread), that is not paused by the reader or by low
   storage, on a Thread whose dispatch gate is open — one whose pause
   the stop recorded, one whose restart only the boot discovered, or one that
   never started. For each Project holding such prompts it brings the Project
   back, which starts acquiring the Project's own sandbox, and re-enqueues
   those prompts in the order the log accepted them, each opening its next
   attempt with `prompt.resumed { attempt }`.
5. It brings back every other non-terminal Project, so each starts acquiring
   its sandbox too, after the Projects of step 4.

These steps run at the `workspace_reconciliation` stage, before HTTP starts
listening, while sandbox acquisition continues in the background so full
capacity cannot block boot. A finished prompt never runs again.

A prompt the host has already taken up twice is closed as a failure instead,
with `resume_exhausted` and a message telling the reader to send the prompt
again, so a host that keeps dying on one prompt stops circling it. An
interrupted prompt resumes from the provider history persisted as its run
advanced — the assistant turns and tool results it already had; a history that
ends in a tool call the restart interrupted is answered before it continues,
and the reader's own input is never repeated. The reader can take up an
unfinished prompt through `POST /threads/:id/resume`, which no budget bounds
([`domain/prompts.ts`](../../../bundles/runtime/runtime/src/host/domain/prompts.ts),
[`store/progress.ts`](../../../bundles/runtime/runtime/src/host/store/progress.ts),
[`default/src/host/executor.ts`](../../../bundles/runtime/default/src/host/executor.ts)).

### On-demand sandboxes

A process holds a live runtime only for the Projects it has brought back. The
other operations treat a Project without one this way
([`domain/service.ts`](../../../bundles/runtime/runtime/src/host/domain/service.ts)):

- Sending a prompt, resuming a prompt or reopening the queue of a Project that
  has no runtime brings it back first: it reacquires its sandbox with the
  Project's own identity, sets the Project and its Threads `ready`, and then
  runs the prompt, keeping arrival order when several prompts race to bring it
  back. A Project that cannot come back answers `inactive`.
- A read that needs a lease never brings a Project back. It answers `pending`
  while the acquisition is in flight, `unavailable` when the process holds no
  runtime for the Project or it is closing, `expired` for a terminal Project
  and `missing` for an unknown one.
- Terminating a Thread needs no runtime: the Thread and its subtree go through
  `cancelling -> cancelled` durably, so it can be deleted without prompting
  first. Terminating a Project without a runtime loads it and ends it.
- Every acquisition writes the Git credentials the configuration in force
  names into the sandbox (see
  [Git and GitHub inside the sandbox](#git-and-github-inside-the-sandbox)),
  then validates each Thread's working directory in one probe; a directory
  missing from the sandbox is reset to the workspace root, and a probe that
  cannot run keeps every directory (see
  [the Thread working directory](#the-thread-working-directory)).
- Each Project records the runtime process that holds it. While a draining
  generation of bundles still holds a Project, the active one waits for its
  release before it brings the Project back; generations are described in
  [Projects and Threads](../../../docs/features/projects-and-threads.md).

## REST API

The [`transport`](../../../bundles/foundation/transport/README.md) bundle
serves the REST API on the host's shared Express app, and the
[`screen-relay`](../../../bundles/features/screen-relay/README.md) bundle adds
one relayed path tree to the same app. No other bundle and nothing in the
kernel registers an HTTP route
([`host/app.ts`](../../../bundles/foundation/transport/src/host/app.ts),
[`kernel.ts`](../../../bundles/foundation/transport/src/kernel.ts),
[`screen-relay/src/host/index.ts`](../../../bundles/features/screen-relay/src/host/index.ts),
[`src/index.ts`](src/index.ts)). The routes carry no authentication: who can
reach the port is the only control
([`routes/credentials.ts`](../../../bundles/foundation/transport/src/host/routes/credentials.ts)).
The routes call the contracts of the bundles that own each resource, and
those bundles' READMEs describe the behavior behind each answer: the
[`runtime`](../../../bundles/runtime/runtime/README.md) for Projects, Threads,
prompts and replay, [`files`](../../../bundles/features/files/README.md) and
[`git`](../../../bundles/features/git/README.md) for workspace reads,
[`terminal`](../../../bundles/features/terminal/README.md),
[`resources`](../../../bundles/features/resources/README.md),
[`usage`](../../../bundles/features/usage/README.md) and
[`host-config`](../../../bundles/foundation/host-config/README.md).

### Routes

Every path is served at the root of the host's port (default `3000`). A
Project, Thread or credential `:id`, a `:promptId` and the page cursors are
UUIDs
([`routes/input.ts`](../../../bundles/foundation/transport/src/host/routes/input.ts));
a terminal `:id` and a VM `:id` are opaque strings whose form no route checks
([`routes/terminals.ts`](../../../bundles/foundation/transport/src/host/routes/terminals.ts),
[`routes/vms.ts`](../../../bundles/foundation/transport/src/host/routes/vms.ts)).

Configuration, credentials, providers, tools and the host machine
([`routes/config.ts`](../../../bundles/foundation/transport/src/host/routes/config.ts),
[`routes/credentials.ts`](../../../bundles/foundation/transport/src/host/routes/credentials.ts),
[`routes/providers.ts`](../../../bundles/foundation/transport/src/host/routes/providers.ts),
[`routes/tools.ts`](../../../bundles/foundation/transport/src/host/routes/tools.ts),
[`routes/resources.ts`](../../../bundles/foundation/transport/src/host/routes/resources.ts),
[`routes/vms.ts`](../../../bundles/foundation/transport/src/host/routes/vms.ts)):

| Method | Path                | Payload                                              | Success answer                               |
| ------ | ------------------- | ---------------------------------------------------- | -------------------------------------------- |
| GET    | `/config`           | —                                                    | 200 `{ configuration, revision, updatedAt }` |
| PUT    | `/config`           | body: the `configuration` object                     | 200 `{ configuration, revision, updatedAt }` |
| GET    | `/credentials`      | —                                                    | 200 array of credential descriptions         |
| POST   | `/credentials`      | body: `{ kind, name, …fields }`                      | 201 credential description                   |
| PATCH  | `/credentials/:id`  | body: `{ name?, username?, email?, secret?, kind? }` | 200 credential description                   |
| DELETE | `/credentials/:id`  | —                                                    | 204                                          |
| GET    | `/providers/kinds`  | —                                                    | 200 `{ kinds }`                              |
| POST   | `/providers/models` | body: `{ kind, configuration }`                      | 200 `{ models }`                             |
| GET    | `/tools`            | —                                                    | 200 `{ tools }`                              |
| GET    | `/resources`        | —                                                    | 200 host resources                           |
| GET    | `/vms`              | —                                                    | 200 array of `{ id, provider }`              |
| GET    | `/vms/:id/ssh`      | `:id` is a VM id (any string)                        | 200 `{ vm, projectId, ssh }`                 |

Projects and their workspace
([`routes/projects.ts`](../../../bundles/foundation/transport/src/host/routes/projects.ts),
[`routes/terminals.ts`](../../../bundles/foundation/transport/src/host/routes/terminals.ts)):

| Method | Path                          | Payload                                       | Success answer                                     |
| ------ | ----------------------------- | --------------------------------------------- | -------------------------------------------------- |
| POST   | `/projects`                   | body: `{ name }`                              | 202 Project plus `ssh.href`                        |
| GET    | `/projects`                   | query: `limit?`, `cursor?`                    | 200 page of Projects                               |
| GET    | `/projects/:id`               | —                                             | 200 Project                                        |
| PATCH  | `/projects/:id`               | body: `{ name }`                              | 200 Project                                        |
| PATCH  | `/projects/:id/color`         | body: `{ color }`                             | 200 Project                                        |
| POST   | `/projects/:id/threads`       | body: `{ name, parentThreadId? }`             | 201 Thread                                         |
| GET    | `/projects/:id/threads`       | query: `limit?`, `cursor?`, `parentThreadId?` | 200 page of Threads                                |
| GET    | `/projects/:id/ssh`           | —                                             | 200 SSH access, or 202 while pending               |
| GET    | `/projects/:id/files`         | query: `path?`                                | 200 `{ path, entries }`, or 202                    |
| GET    | `/projects/:id/tree`          | query: `path?`                                | 200 `{ path, entries }`, or 202                    |
| GET    | `/projects/:id/files/content` | query: `path`                                 | 200 `{ path, content, truncated, binary }`, or 202 |
| GET    | `/projects/:id/diff`          | query: `path?`                                | 200 `{ path?, repositories }`, or 202              |
| GET    | `/projects/:id/changes`       | query: `path?`                                | 200 `{ path?, repositories }`, or 202              |
| GET    | `/projects/:id/files/diff`    | query: `repository`, `path`                   | 200 file diff, or 202                              |
| GET    | `/projects/:id/resources`     | —                                             | 200 sandbox resources, or 202                      |
| GET    | `/projects/:id/terminals`     | —                                             | 200 `{ items }`                                    |
| POST   | `/projects/:id/terminate`     | —                                             | 200 Project                                        |
| DELETE | `/projects/:id`               | —                                             | 204                                                |

Threads
([`routes/threads.ts`](../../../bundles/foundation/transport/src/host/routes/threads.ts),
[`routes/terminals.ts`](../../../bundles/foundation/transport/src/host/routes/terminals.ts)):

| Method | Path                           | Payload                                               | Success answer                                                     |
| ------ | ------------------------------ | ----------------------------------------------------- | ------------------------------------------------------------------ |
| GET    | `/threads/:id`                 | —                                                     | 200 Thread                                                         |
| PATCH  | `/threads/:id`                 | body: `{ name?, cwd?, providerId?, model?, effort? }` | 200 Thread                                                         |
| GET    | `/threads/:id/git`             | —                                                     | 200 Git summary, or `{ status }`                                   |
| GET    | `/threads/:id/branches`        | —                                                     | 200 `{ branches, blocked? }`, or `{ status }`                      |
| POST   | `/threads/:id/branches`        | body: `{ branch, cwd }`                               | 200 `{ branches, blocked? }`                                       |
| POST   | `/threads/:id/prompt`          | body: `{ prompt }`                                    | 202 `{ promptId }`                                                 |
| POST   | `/threads/:id/steer`           | body: `{ prompt, promptId, interrupt? }`              | 202 `{ status, promptId }`                                         |
| POST   | `/threads/:id/resume`          | body: `{ promptId }`                                  | 202 Thread                                                         |
| POST   | `/threads/:id/rewind`          | body: `{ promptId, prompt }`                          | 202 `{ promptId }`                                                 |
| POST   | `/threads/:id/compact`         | —                                                     | 200 `{ status, condensedMessages, retainedMessages, tokensFreed }` |
| POST   | `/threads/:id/interrupt`       | body: `{ promptId }`                                  | 200 `{ status: 'interrupted' }`                                    |
| GET    | `/threads/:id/events`          | query: `afterSequence?`                               | 200 `{ events, lastSequence }`                                     |
| GET    | `/threads/:id/usage`           | —                                                     | 200 Thread usage                                                   |
| GET    | `/threads/:id/queue`           | —                                                     | 200 queue snapshot                                                 |
| POST   | `/threads/:id/queue/resume`    | —                                                     | 200 Thread                                                         |
| GET    | `/threads/:id/queue/:promptId` | —                                                     | 200 `{ promptId, text, revision, editable }`                       |
| PATCH  | `/threads/:id/queue/:promptId` | body: `{ text, revision }`                            | 200 `{ promptId, text, revision, editable }`                       |
| DELETE | `/threads/:id/queue/:promptId` | —                                                     | 204                                                                |
| POST   | `/threads/:id/terminals`       | body: `{ cols?, rows? }`                              | 201 terminal session                                               |
| POST   | `/threads/:id/terminate`       | —                                                     | 200 Thread                                                         |
| DELETE | `/threads/:id`                 | —                                                     | 204                                                                |

Terminals
([`routes/terminals.ts`](../../../bundles/foundation/transport/src/host/routes/terminals.ts)):

| Method | Path                    | Payload                         | Success answer        |
| ------ | ----------------------- | ------------------------------- | --------------------- |
| GET    | `/terminals/:id`        | query: `after?` (output offset) | 200 terminal snapshot |
| POST   | `/terminals/:id/input`  | body: `{ data }`                | 204                   |
| POST   | `/terminals/:id/resize` | body: `{ cols, rows }`          | 204                   |
| DELETE | `/terminals/:id`        | —                               | 204                   |

The screen relay
([`screen-relay/src/host/relay.ts`](../../../bundles/features/screen-relay/src/host/relay.ts)):

| Method | Path                     | Payload           | Success answer                  |
| ------ | ------------------------ | ----------------- | ------------------------------- |
| any    | `/screen/<token>/<path>` | relayed unchanged | the screen session's own answer |

### Conventions

- **Bodies.** A body is JSON, parsed by `express.json()` with its defaults
  (100 KB). A body that is not valid JSON, or one over that size, answers
  `500 internal_error`; a request without a JSON content type reaches its
  route with no body
  ([`host/app.ts`](../../../bundles/foundation/transport/src/host/app.ts),
  [`host/errors.ts`](../../../bundles/foundation/transport/src/host/errors.ts)).
  Every body schema is strict: an unknown key answers the route's `422`.
- **Errors.** A refusal answers `{ error: { code, message } }`. An unexpected
  failure of any route answers `500 { error: { code: 'internal_error',
message: 'The request could not be completed.' } }` and never carries the
  cause ([`host/errors.ts`](../../../bundles/foundation/transport/src/host/errors.ts)).
  A path no route serves answers Express's own `404` page.
- **IDs.** A Project, Thread or credential `:id` that is not a UUID answers
  `400 invalid_project_id`, `invalid_thread_id` or `invalid_credential_id`; a
  well-formed one that names nothing answers `404 <kind>_not_found` with
  `The <kind> was not found.`. A lifecycle conflict answers
  `409 <kind>_<reason>` with `The <kind> cannot perform this operation.`,
  except `<kind>_storage_low`, whose message is `Execution paused: storage is
low or unavailable. Free disk space above 10% and resume the queue.`
  ([`routes/input.ts`](../../../bundles/foundation/transport/src/host/routes/input.ts),
  [`contracts/rest-errors.ts`](../../../bundles/runtime/runtime/src/contracts/rest-errors.ts),
  [`contracts/model.ts`](../../../bundles/runtime/runtime/src/contracts/model.ts)).
  `GET /projects/:id/terminals` and `POST /threads/:id/terminals` are served
  by the terminal router, mounted before the Project and Thread routers, and
  do not test the form of `:id`
  ([`host/app.ts`](../../../bundles/foundation/transport/src/host/app.ts)).
- **Pages.** `GET /projects` and `GET /projects/:id/threads` answer
  `{ items, nextCursor? }`, newest first. `limit` is 1–100 (default 50), and
  `cursor` is the id of the last item of the previous page; an invalid
  `limit` or `cursor` answers `400 invalid_page`, and a cursor that names no
  item of that list answers an empty page. Without `parentThreadId`, the
  Threads page holds every Thread of the Project, children included; with
  it, only the direct children of that Thread, and a cursor naming a Thread
  with another parent answers an empty page. Page size does not limit how
  many Projects or Threads exist
  ([`routes/input.ts`](../../../bundles/foundation/transport/src/host/routes/input.ts),
  [`store/projects.ts`](../../../bundles/runtime/runtime/src/host/store/projects.ts),
  [`store/threads.ts`](../../../bundles/runtime/runtime/src/host/store/threads.ts)).
- **Names.** A Project or Thread name is trimmed, contains no NUL, and has 1–80
  Unicode characters
  ([`contracts/model.ts`](../../../bundles/runtime/runtime/src/contracts/model.ts)).
- **Records.** A Project is `{ id, name, color?, state, configRevision,
errorCode?, createdAt, updatedAt, startedAt?, finishedAt? }`. A Thread is
  `{ id, projectId, parentThreadId?, origin?, name, state, lastSequence,
queuePaused?, cwd, cwdRepo?, activePromptId?, executionStartedAt?,
lastExecutionMs?, errorCode?, createdAt, updatedAt, startedAt?,
finishedAt?, result?, agent?, model?, effort?, providerId?, archivedAt?,
pinned? }`, where `origin` is `user` or `agent`, `result` is
  `{ status, text, promptId, at }` of its latest finished prompt, and `agent`
  is `{ name, source }`. Neither carries message history, prompt text, a
  credential or an SSH key
  ([`contracts/model.ts`](../../../bundles/runtime/runtime/src/contracts/model.ts)).
  The states are listed under
  [Project and Thread lifecycle](#project-and-thread-lifecycle).
- **Caching.** Every answer of the REST routes carries
  `Cache-Control: no-store`: the terminal router, mounted first at the root,
  sets it on every request that passes through it
  ([`routes/terminals.ts`](../../../bundles/foundation/transport/src/host/routes/terminals.ts),
  [`host/app.ts`](../../../bundles/foundation/transport/src/host/app.ts)).
- **Answers grow.** An answer may gain optional fields. A client ignores the
  fields it does not know.

### Configuration and providers

`GET /config` answers `{ configuration, revision, updatedAt }`: the active
configuration, the revision it is stored under, and when it was stored
([`config/service.ts`](../../../bundles/foundation/host-config/src/host/config/service.ts),
[`config/schema.ts`](../../../bundles/foundation/host-config/src/host/config/schema.ts)).
The `configuration` object holds no secret: a provider names the `API_TOKEN`
credential it authenticates with, and `gitCredentialId` /
`githubCredentialId` name the `GIT` identity and the `API_TOKEN` GitHub uses.
Its keys are `providers` (at least one `{ id, kind, configuration, models? }`,
each model `{ name, reasonings?, defaultEffort?, mandatory? }`), `models`
(`{ execution: { providerId, model, effort? } }`), `execution`
(`{ maxTurns, maxToolResultChars?, contextCompaction? }`), and the optional
`tools`, `gitCredentialId`, `githubCredentialId`, `profile` and `threads`.
[Configuration](#configuration) describes what each one sets.

`PUT /config` takes the `configuration` object as its whole body and replaces
the active one. It answers the stored `{ configuration, revision, updatedAt }`,
so the `configuration` it answers is a body it accepts. Replacements run one
at a time, in request order
([`routes/config.ts`](../../../bundles/foundation/transport/src/host/routes/config.ts),
[`config/service.ts`](../../../bundles/foundation/host-config/src/host/config/service.ts)):

1. A body the schema refuses, an unknown key included, answers
   `422 invalid_config` with `The Doric configuration is invalid.`.
2. A reference to a credential that is not stored or is of the wrong kind,
   and a value a loaded tool requires but the body leaves out, answer
   `422 invalid_config` with a message naming the fault.
3. Each provider that lists models has its kind's catalog read: each listed
   model takes the reasoning efforts, the default effort and the mandatory
   flag the catalog gives it, and a model the catalog does not name takes
   none. A provider whose kind sets `modelsFromCatalog` is read even with no
   models, and its list becomes every model the catalog lists, in the
   catalog's order. A catalog that cannot be read leaves that provider as it
   was, so an unreachable endpoint never costs the configuration its model
   list. The execution effort then resolves to the one its model starts at,
   or is dropped when that model lists none
   ([`models/catalog.ts`](../../../bundles/foundation/core/src/host/models/catalog.ts)).
4. The providers are built before anything is stored, then the configuration
   is stored and activated. Any failure from here answers
   `503 configuration_rejected` with `The Doric configuration could not be
activated.`, and the configuration in force stays.

A configuration saved here reaches the next prompt of any Project, including
one that is already running.

`GET /providers/kinds` answers `{ kinds }`: the provider kinds a provider
bundle registers and advertises, as `models/v1` lists them
([`routes/providers.ts`](../../../bundles/foundation/transport/src/host/routes/providers.ts),
[`models/index.ts`](../../../bundles/foundation/core/src/host/models/index.ts),
[`basic/models.ts`](../../../packages/bundle/src/contracts/basic/models.ts)).
A registered kind that is not advertised, such as `codex`
([`codex/src/host/kind.ts`](../../../bundles/providers/codex/src/host/kind.ts)),
is absent from the list and still accepted: `POST /providers/models` looks a
kind up among every registered kind, and `PUT /config` accepts any kind the
provider catalog knows
([`config/schema.ts`](../../../bundles/foundation/host-config/src/host/config/schema.ts)).
Each kind is `{ id, label, description, fields, lists, modelsFromCatalog?,
site? }`:

- each field is `{ key, label, kind, required, description?, placeholder?,
options?, advanced? }`, with `kind` one of `text`, `url`, `number`, `enum`
  and `secret`;
- `lists` names what the kind keeps per provider: `models`, `reasonings`, or
  both;
- `modelsFromCatalog: true` marks a kind whose model list is its live
  catalog;
- `site` is `{ url, label }`: the `https:` page a client may link to, with the
  link's label. It is absent when the kind has none.

`POST /providers/models` asks what a draft provider's endpoint serves, before
the provider is saved. The body is `{ kind, configuration }`, where
`configuration` maps the kind's field keys to strings. It answers
`{ models }`, each `{ id, name?, reasonings, parameters, defaultEffort?,
mandatory }`: the model's reasoning efforts, the request parameters it
advertises, the effort it names as its default, and whether it pins reasoning
on ([`routes/providers.ts`](../../../bundles/foundation/transport/src/host/routes/providers.ts),
[`basic/models.ts`](../../../packages/bundle/src/contracts/basic/models.ts)).

- `422 invalid_provider` (`The provider values are invalid.`): the body is
  malformed, the kind is unknown, a key is not a field of the kind, a value
  is empty, a required field is missing, or a value does not fit its field
  (`url` starts with `http://` or `https://`, `number` is finite, `enum` is
  one of `options`, `secret` is a UUID). Only the form of a `secret` value is
  checked: a UUID that names no credential passes, and the catalog is then
  read without a secret
  ([`models/index.ts`](../../../bundles/foundation/core/src/host/models/index.ts)).
- `502 model_catalog_unreadable` (`The provider model catalog could not be
read.`): the kind has no catalog, or the read failed.

### Credentials

`/credentials` owns the credential store
([`routes/credentials.ts`](../../../bundles/foundation/transport/src/host/routes/credentials.ts),
[`secrets/facade.ts`](../../../bundles/foundation/core/src/host/secrets/facade.ts),
[`basic/secrets.ts`](../../../packages/bundle/src/contracts/basic/secrets.ts)).
A credential description is `{ id, kind, name, username?, email?, hasSecret }`
and never carries the secret.

- **Kinds.** A kind fixes the fields a credential carries: `API_TOKEN` takes
  `secret`, `USERNAME_PASSWORD` takes `username` and `secret`, and `GIT`,
  which the `git` bundle registers, takes `username` and `email`
  ([`git/src/host/credentials.ts`](../../../bundles/features/git/src/host/credentials.ts)).
  A kind name is 2–32 characters of `A–Z`, `0–9` and `_`, starting with a
  letter.
- **Limits.** `name` and `username` are trimmed and 1–128 characters; `email`
  is an address of at most 256 characters; `secret` is 1–512 characters
  without a line break.
- **POST** takes `{ kind, name }` and the kind's fields. A body that breaks a
  limit, names a kind nothing registered, misses a field the kind requires,
  or carries a field it does not take answers `422 invalid_credential` (`The
credential does not match its kind.`).
- **PATCH** takes any of `name`, `username`, `email`, `secret` and `kind`.
  `name` and `kind` take a string only (`null` answers
  `422 invalid_credential`). `username`, `email` and `secret` also take
  `null` or `''`: an absent or `null` field keeps the stored value, and a
  string, `''` included, replaces it
  ([`secrets/facade.ts`](../../../bundles/foundation/core/src/host/secrets/facade.ts)).
  `''` reaches storage as an empty value — an empty `username` or `email`
  column, a sealed empty `secret`, which needs `DORIC_CREDENTIAL_KEY` like
  any secret — and counts as present for the kind's field rule, so `''` on a
  field the kind does not take answers `422 invalid_credential`
  ([`secrets/backend.ts`](../../../bundles/foundation/postgres/src/host/secrets/backend.ts)).
  A client sees it as cleared: the description omits an empty `username` or
  `email` and answers `hasSecret: false` for an empty secret
  ([`secrets/cache.ts`](../../../bundles/foundation/core/src/host/secrets/cache.ts)).
  A `kind` nothing registers answers `422 invalid_credential` first; a
  registered `kind` other than the stored one answers
  `409 credential_kind_immutable`; a result that no longer fits the kind
  answers `422 invalid_credential`.
- A `422 invalid_credential` the secrets contract raises (a field rule or an
  unknown kind it finds) carries that contract's message, such as `A GIT
credential requires username, email and carries no other field.`, instead
  of `The credential does not match its kind.`
  ([`routes/credentials.ts`](../../../bundles/foundation/transport/src/host/routes/credentials.ts),
  [`basic/secrets.ts`](../../../packages/bundle/src/contracts/basic/secrets.ts)).
- A `name` already used by a credential of the same kind answers
  `409 credential_name_taken`
  ([`secrets/backend.ts`](../../../bundles/foundation/postgres/src/host/secrets/backend.ts)).
- **DELETE** of a credential a provider or the configuration names answers
  `409 credential_referenced`; the reference check runs before the store is
  touched.
- A write of a secret while `DORIC_CREDENTIAL_KEY` is not configured answers
  `503 credential_storage_unavailable` (`The host cannot store credential
secrets.`). [Persistence and security](#persistence-and-security) describes
  how secrets are sealed.

### Tools, resources and VMs

- `GET /tools` answers `{ tools }`, one `{ name, description?, settings }` per
  tool the active bundle generation exposes; `settings` lists the
  configuration fields the tool declares, each `{ key, label, kind, required,
description?, placeholder?, default?, options?, advanced? }`. The read runs
  no tool
  ([`routes/tools.ts`](../../../bundles/foundation/transport/src/host/routes/tools.ts),
  [`types/tool.ts`](../../../packages/tool/src/lib/types/tool.ts)).
- `GET /resources` reads the machine the host runs on and needs no Project:
  `{ at, cpuCount, cpuPercent?, loadAverage?, memoryTotalBytes,
memoryUsedBytes, uptimeSeconds }`. `cpuPercent` is absent on the first
  reading of the process
  ([`routes/resources.ts`](../../../bundles/foundation/transport/src/host/routes/resources.ts),
  [`resources/src/contracts/index.ts`](../../../bundles/features/resources/src/contracts/index.ts)).
- `GET /vms` answers the machines the sandbox provider runs, each
  `{ id, provider }` with `provider` `docker` or `firecracker`.
  `GET /vms/:id/ssh` answers `{ vm, projectId, ssh }`, where `ssh` is
  `{ host, port, username: 'root', privateKey, knownHosts,
hostKeyFingerprint }`; an unknown VM answers `404 vm_not_found`, and a VM
  without SSH access `409 vm_ssh_unavailable`
  ([`routes/vms.ts`](../../../bundles/foundation/transport/src/host/routes/vms.ts),
  [`contracts/sandbox.ts`](../../../bundles/runtime/runtime/src/contracts/sandbox.ts),
  [`contracts/runtime.ts`](../../../bundles/runtime/runtime/src/contracts/runtime.ts),
  [`types/sandbox.ts`](../../../packages/sandbox/src/lib/types/sandbox.ts)).

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

### Request rules

Each route turns the runtime's outcome into an answer as below
([`routes/projects.ts`](../../../bundles/foundation/transport/src/host/routes/projects.ts),
[`routes/threads.ts`](../../../bundles/foundation/transport/src/host/routes/threads.ts),
[`contracts/rest-errors.ts`](../../../bundles/runtime/runtime/src/contracts/rest-errors.ts));
the runtime's side of each outcome is in
[`domain/service.ts`](../../../bundles/runtime/runtime/src/host/domain/service.ts)
and [`domain/runner.ts`](../../../bundles/runtime/runtime/src/host/domain/runner.ts).

- **Project creation** takes `{ name }` (`422 invalid_project` otherwise)
  and answers `202` with the Project plus
  `ssh: { href: '/projects/<id>/ssh' }`. The host marks the Project with a
  random color of the palette `red`, `orange`, `amber`, `green`, `teal`,
  `blue`, `violet`, `pink`, and starts acquiring its sandbox
  ([`domain/colors.ts`](../../../bundles/runtime/runtime/src/host/domain/colors.ts)).
- **Project PATCH** takes `{ name }` only (`422 invalid_project` otherwise);
  **color** takes `{ color }`, a palette color or `null`
  (`422 invalid_project_color` otherwise). Both answer the Project.
- **Project terminate** answers the Project. **Project DELETE** answers `204`,
  or `409 project_active` while the Project or one of its Threads is not
  terminal.
- **Thread creation** takes `{ name, parentThreadId? }`
  (`422 invalid_thread` otherwise) and answers `201` with the Thread. A child
  starts in its parent's working directory. A top-level Thread copies the
  workspace default execution and a child its parent's; when the
  configuration cannot be read, creation answers `500 internal_error` and
  creates nothing. A missing Project answers `404 project_not_found`; a
  Project the host holds no runtime for, or one that is closing, answers
  `409 thread_inactive`. A `parentThreadId` that names no Thread of the
  Project, or names a child Thread, answers `409 thread_invalid_parent`: a
  Thread created over REST hangs off a top-level Thread.
- **Thread PATCH** takes `name`, `cwd`, an execution (`providerId` and
  `model`, optional `effort`), or any combination. `providerId` (1–128
  characters) and `model` (1–512) come together, and `effort` (`none`,
  `minimal`, `low`, `medium`, `high`, `xhigh`, `max`) only with them; any
  other body answers `422 invalid_thread` with `A Thread name, a working
directory, an execution (providerId and model, with an optional effort), or
a combination is required.`. The changes apply in the order name, `cwd`,
  execution, and a change that applied stays when a later one is refused.
  `cwd` is described under
  [The Thread working directory](#the-thread-working-directory). The
  execution is checked against the configuration — the provider must be
  configured, the model listed for it, and the effort one the model takes —
  and then `models/v1.resolve` must accept it
  ([`domain/execution.ts`](../../../bundles/runtime/runtime/src/host/domain/execution.ts)).
  A refusal answers `422 invalid_execution` with `The provider is not
configured.`, `The model is not available on this provider.` or `This model
does not support that effort.`, or with the message `models/v1.resolve`
  rejected with. A valid execution is stored on the Thread as `providerId`,
  `model` and `effort` and applies from its next run.
- **Thread archive.** A Thread may carry `archivedAt` and `pinned`; no REST
  route sets them (the desktop sets them through `runtime.threads/v1`).
- **Thread terminate** cancels the Thread's subtree and answers the Thread.
  **Thread DELETE** deletes the Thread's subtree and answers `204`, or
  `409 thread_active` while a Thread of the subtree is not terminal. On a
  Thread an agent opened that is not archived, the runtime deletes nothing
  and the route answers `204`.
- **Prompt** takes only a non-empty `prompt` (`422 invalid_prompt`, `Only a
non-empty prompt is accepted.`) and answers `202 { promptId }`. It brings
  the Project's sandbox back first when the host holds none. Every refusal
  other than a missing Thread — a terminal or closing Thread, a Project that
  cannot run, or a Thread an agent opened — answers `409 thread_inactive`.
  A caller cannot set the input's origin or its correlation: the input is
  always the reader's.
- **Steer** takes `{ prompt, promptId, interrupt? }` (`422 invalid_steer`
  otherwise) and answers `202 { status, promptId }` with the new input's id.
  `status` is `steered` when `promptId` names the prompt the Thread is
  running; the run reads the steer at its next safe point, and with
  `interrupt: true` the running step is aborted so the run turns to the steer
  at once. It is `queued` when that prompt is not running, the queue is
  stopped, or the Thread is stopping or pausing; the steer then joins the
  back of the queue like an ordinary prompt. When the run ends while the
  steer is being accepted, the steer waits at the front of the queue
  instead. Refusals answer as a prompt's do.
- **Rewind** takes `{ promptId, prompt }` (`422 invalid_rewind` otherwise)
  and answers `202 { promptId }` like a prompt. The runtime truncates the
  Thread's event log at the first event of the named prompt, has the executor
  cut the provider-ready history at the same turn, appends one
  `history.truncated` event, and accepts the edited text as a new reader
  input
  ([`store/threads.ts`](../../../bundles/runtime/runtime/src/host/store/threads.ts)).
  A Thread that is running or has queued input answers `409 thread_busy`
  (`The Thread is running or has queued input and cannot be rewound.`), so
  queued work never runs on truncated history; a prompt the log does not
  hold, or one the executor cannot rewind to, answers `404 prompt_not_found`;
  a terminal or closing Thread, a Project without a runtime, and a Thread an
  agent opened answer `409 thread_inactive`.
- **Interrupt** takes `{ promptId }` (`422 invalid_interrupt` otherwise) and
  answers `200 { status: 'interrupted' }`, also when the Thread is already
  stopped. `promptId` must be a UUID but names nothing: any UUID stops the
  Thread's queue and aborts whatever prompt it is running
  ([`domain/service.ts`](../../../bundles/runtime/runtime/src/host/domain/service.ts)); [Stop, rewind, terminate, delete](#stop-rewind-terminate-delete)
  describes the effect. A Thread that is closing, terminal, or has no runtime
  answers `409 thread_inactive`.
- **Resume** takes `{ promptId }` (`422 invalid_resume` otherwise) and
  answers `202` with the Thread. It takes up that one prompt no run has
  finished, bringing the Project's sandbox back when the host holds none, and
  records the next `prompt.resumed` attempt; on a stopped queue it reopens
  the queue with that prompt first. A prompt the Thread has not left
  unfinished answers `404 prompt_not_found`, one it already holds running
  `409 thread_busy`, a terminal Thread or a Project that cannot run
  `409 thread_inactive`, and low storage `409 thread_storage_low`.
- **Compact** condenses an idle Thread's context on demand and answers
  `200 { status: 'compacted', condensedMessages, retainedMessages,
tokensFreed }`. A running or queued Thread answers `409 thread_busy`; a
  refusal answers `409 compaction_refused` with `Context compaction is
disabled in the settings.`, `This Thread has no conversation to compact
yet.` or `Nothing condenses here: the recent conversation is already the
smallest safe span.`; a failed attempt answers `502 compaction_failed` with
  its code (`summarizer_failed` or `unsafe_boundary`) in the message; a
  history the executor cannot read answers `409 thread_not_supported`; a
  terminal or closing Thread answers `409 thread_inactive`.
- **SSH.** `GET /projects/:id/ssh` answers
  `{ status: 'ready', vmId, ssh, href }`, where `ssh` is the access
  `GET /vms/:id/ssh` describes and `href` is `/vms/<vmId>/ssh`. While the
  sandbox is pending it answers `202 { status: 'pending' }` with
  `Retry-After: 1`; an expired lease answers `410 project_ssh_expired`, and
  any other state `409 project_ssh_unavailable`.
- **Usage.** `GET /threads/:id/usage` answers `{ context?, total, threads }`:
  `total` and each entry of `threads` count `calls`, `unpricedCalls`, `cost`,
  `inputTokens`, `outputTokens`, `cachedInputTokens` and `reasoningTokens`,
  each entry naming its `threadId`, `name` and `parentThreadId?`; `context`
  is `{ model, providerId?, contextWindowSource?, contextWindow?,
inputTokens? }`, the context window filled from the model catalog when it
  knows the model
  ([`usage/src/contracts/index.ts`](../../../bundles/features/usage/src/contracts/index.ts),
  [`contracts/model.ts`](../../../bundles/runtime/runtime/src/contracts/model.ts)).

### Workspace reads

`GET /projects/:id/files`, `/tree`, `/files/content`, `/diff`, `/changes`,
`/files/diff` and `/resources` read the Project's sandbox on its current
lease and never acquire one. They share the lease answers:
`202 { status: 'pending' }` with `Retry-After: 1` while the environment is
pending, `410 project_files_expired` when the lease expired, and
`409 project_files_unavailable` otherwise
([`routes/projects.ts`](../../../bundles/foundation/transport/src/host/routes/projects.ts),
[`files/src/host/reads.ts`](../../../bundles/features/files/src/host/reads.ts)).

- A `path` is at most 4096 characters without NUL, relative to the workspace
  root. One that escapes the workspace, or is malformed, answers
  `422 invalid_project_path`; a missing path answers
  `404 project_path_not_found`; a path of the wrong type answers
  `422 invalid_project_path`. The wrong-type message is `The Project path is
not a directory.` on `/files` and `/tree`, `The Project path is not a
readable file.` on `/files/content`, `The Project path is invalid.` on
  `/diff`, `The Project path cannot be read.` on `/changes` (its `404` too),
  and `The changed file cannot be read.` on `/files/diff` (its `404` too).
- `/files` lists one directory level and `/tree` the whole tree below the
  path, each as `{ path, entries }`; an entry is `{ name, path, type, size? }`,
  and a tree entry of a directory adds its `children`
  ([`types/files.ts`](../../../packages/sandbox/src/lib/types/files.ts)).
- `/files/content` reads one file as UTF-8 text capped at 256 KiB
  (`CONTENT_LIMIT_BYTES`) and answers `{ path, content, truncated, binary }`;
  a binary file answers empty `content` with `binary: true`, so it is never
  rendered as mangled text
  ([`files/src/host/reads.ts`](../../../bundles/features/files/src/host/reads.ts)).
- `/diff` answers `{ path?, repositories }`, one `{ path, diff, changes }` per
  repository, where each change is `{ path, status }`. A Git diff never
  contains untracked files, so `changes` supplies them alongside `diff`.
  `/changes` answers one `{ path, changes, added, removed }` per repository,
  each change with its `status` (`added`, `modified`, `deleted`, `renamed`,
  `untracked`, `conflicted`), `originalPath?`, `staged`, `unstaged`,
  `indexStatus` and `worktreeStatus`
  ([`git/src/host/changes.ts`](../../../bundles/features/git/src/host/changes.ts),
  [`git/src/contracts/index.ts`](../../../bundles/features/git/src/contracts/index.ts),
  [`git/src/contracts/reads.ts`](../../../bundles/features/git/src/contracts/reads.ts)).
- A `path` on `/diff` and `/changes` also scopes discovery: the repositories
  read are the ones that path belongs to or holds, which is how one Thread
  reads the changes of its own working directory. Discovery stops at each
  repository boundary, so a nested repository is left to the outer one.
- `/files/diff` compares one changed file, HEAD against the working tree.
  `repository` and `path` are workspace-relative, and it answers that file's
  change fields plus `{ repository, original, modified, binary, truncated }`.
- `/resources` answers the sandbox's own usage: `{ status, at, cpuPercent?,
cpuCount?, memoryUsedBytes?, memoryLimitBytes? }`, where `status` is
  `ready` or `unavailable`
  ([`resources/src/contracts/index.ts`](../../../bundles/features/resources/src/contracts/index.ts)).

### The Thread working directory

Every Thread owns a working directory inside its Project's shared sandbox. It
starts at `/workspace`, and the agent moves it with its `cwd` tool, which
applies the same rule the HTTP route does
([`domain/runner.ts`](../../../bundles/runtime/runtime/src/host/domain/runner.ts),
[`domain/cwd.ts`](../../../bundles/runtime/runtime/src/host/domain/cwd.ts)).

- `PATCH /threads/:id` takes an optional `cwd` of at most 4096 characters,
  without NUL and not blank: an absolute sandbox path, or one relative to the
  Thread's current directory the way `cd` reads it. A blank or
  whitespace-only `cwd` answers `422 invalid_thread`.
- A move that would leave the workspace root, through a symbolic link
  included, answers `400 invalid_cwd` with `The working directory must stay
inside the workspace.`; one that names nothing answers it with `No such
directory.`, and one that names a file with `The working directory must be
a directory.`. A Thread without a runtime answers `409 thread_inactive`. A
  valid move answers the updated Thread
  ([`routes/threads.ts`](../../../bundles/foundation/transport/src/host/routes/threads.ts)).
- The Thread record carries the directory as `cwd` plus a cheap hint as
  `cwdRepo`: absent unless the directory's own root holds a `.git` marker,
  then `github` when that repository's `origin` points at github.com and
  `git` otherwise
  ([`domain/repository-hint.ts`](../../../bundles/runtime/runtime/src/host/domain/repository-hint.ts)).
- The hint is refreshed whenever the directory moves, when one of the
  Thread's prompts settles, and when the Git summary below is read, and
  `thread:updated` is published only when it changed
  ([`domain/runner.ts`](../../../bundles/runtime/runtime/src/host/domain/runner.ts),
  [`git/src/host/service.ts`](../../../bundles/features/git/src/host/service.ts)).

When a Project reacquires a sandbox, every Thread whose directory is not the
workspace root is checked in one probe: a directory the sandbox no longer
holds — missing, no longer a directory, or resolving outside the root — is
reset to `/workspace` with its hint cleared, and one `thread:updated` is
published for each reset. Only an explicit negative answer resets a
directory: a probe that cannot run keeps every stored directory, because a
command that failed is not evidence that the directories are gone
([`domain/cwd.ts`](../../../bundles/runtime/runtime/src/host/domain/cwd.ts)).

`GET /threads/:id/git` answers the Git summary of the Thread's working
directory
([`git/src/host/status.ts`](../../../bundles/features/git/src/host/status.ts),
[`git/src/contracts/index.ts`](../../../bundles/features/git/src/contracts/index.ts)):

- `{ repo: false }` when the directory holds, or lies in, no repository;
- otherwise `{ repo: true, root, head, detached, unborn, upstream, ahead,
behind, dirty, conflicted, operation, worktree, shallow, stash,
submodules }`: `head` is the branch, or the short commit when HEAD is
  detached; `upstream` and `operation` may be `null`; `dirty` is
  `{ staged, modified, untracked }`; `operation` is `merge`, `rebase`,
  `cherry-pick`, `revert` or `bisect`; the rest are counts and flags.

One sandbox command reads all of it: a `git status --porcelain=v2 --branch`
document, whose headers already carry the branch, its upstream and the
ahead/behind counts, plus the labeled facts a small shell script prints
around it. While the Project's sandbox is not readable, the route still
answers `200` with `{ status: 'pending' }` or `{ status: 'unavailable' }`, so
clients can poll without treating it as an error; an unknown Thread answers
`404 thread_not_found`.

`GET /threads/:id/branches` answers the same way while the sandbox is not
readable, and otherwise `{ branches, blocked? }`: the local branches, newest
commit first, each `{ name, current, commit, subject, worktree }`, and the
sentence that says why switching is blocked, when it is
([`git/src/host/branches.ts`](../../../bundles/features/git/src/host/branches.ts),
[`git/src/host/service.ts`](../../../bundles/features/git/src/host/service.ts)).
`POST /threads/:id/branches` takes `{ branch, cwd }`: an existing local
branch name (1–1024 characters, no NUL, not starting with `-`) and the
working directory the client last read, under the same rule as the `cwd` of
`PATCH /threads/:id` (at most 4096 characters, no NUL, not blank). A body
that breaks either rule answers `422 invalid_branch`. `cwd` is only a guard:
the switch always runs in the Thread's own working directory
([`git/src/host/service.ts`](../../../bundles/features/git/src/host/service.ts)).
It is refused with `409 branch_refused` and its sentence, in this order:

1. `cwd` differs from the Thread's current working directory: `The working
directory changed. Reopen the branch picker and try again.`;
2. running work shares that repository — a Thread of the Project whose
   directory is in it and that runs a prompt or has one queued, or a terminal
   still running there that an agent opened or whose command is not `bash`:
   `Wait for active prompts and terminal commands in this worktree to finish
before switching branches.`;
3. the directory resolves outside the workspace: `The working directory must
stay inside the workspace.`;
4. it lies in no repository: `This directory is not a Git repository.`;
5. the repository root resolves outside the workspace: `The repository must
stay inside the workspace.`;
6. a Git operation or a conflict is in progress: `Finish the current Git
operation and resolve conflicts before switching branches.`;
7. the branch is not a local branch: `This local branch no longer exists.`;
8. it is checked out in another worktree: `This branch is checked out in
another worktree.`;
9. `git switch` fails: `Git could not switch branches. Commit or stash
conflicting local changes and try again.`

`GET` reports refusals 2–6 as `blocked`, the sentence of 2 taking precedence
([`git/src/host/branches.ts`](../../../bundles/features/git/src/host/branches.ts)).
Asking for the branch already checked out runs no switch and answers the
branches unchanged. Otherwise it switches without discarding changes or
creating a stash and answers the branches after the switch. A Thread without a
readable sandbox answers `409 thread_inactive`.

### The prompt queue

The queue routes
([`routes/threads.ts`](../../../bundles/foundation/transport/src/host/routes/threads.ts),
[`domain/service.ts`](../../../bundles/runtime/runtime/src/host/domain/service.ts),
[`domain/runner.ts`](../../../bundles/runtime/runtime/src/host/domain/runner.ts)):

- `GET /threads/:id/queue` answers a revisioned snapshot
  `{ revision, paused, stopping, current?, resumable?, items, error? }`: the
  prompt running, the prompt a stop left resumable, and the FIFO pending
  items, each `{ promptId, source, label, preview, acceptedAt, editable,
revision }` with `source.kind` one of `user`, `terminal`, `parent`,
  `result` and `bundle`. While storage is low the snapshot is `paused`, and
  `error` carries the storage message
  ([`contracts/model.ts`](../../../bundles/runtime/runtime/src/contracts/model.ts)).
- `POST /threads/:id/queue/resume` reopens a stopped queue and answers the
  Thread: it resumes the latest eligible reader-paused prompt first and then
  the FIFO. On a queue that is not stopped and not waiting on storage, it
  does nothing and answers `200` with the Thread, also while a prompt runs.
  A stopped queue whose aborted prompt still runs answers `409 thread_busy`,
  low storage `409 thread_storage_low`, and a terminal Thread or a Project
  that cannot run `409 thread_inactive`.
- `GET /threads/:id/queue/:promptId` answers `{ promptId, text, revision,
editable }`. A `:promptId` that is not a UUID answers `422 invalid_prompt`
  (`A promptId is required.`); a prompt that is no longer queued, or a Thread
  that is missing, terminal or closing, answers `404 unknown_prompt` (`This
  prompt is no longer queued.`).
- `PATCH /threads/:id/queue/:promptId` takes `{ text, revision }`
  (`422 invalid_prompt` otherwise) and answers the edited prompt with its new
  revision. Only a reader input that has never started can be edited. The
  error `code` is the outcome itself: `404 missing` or `404 unknown_prompt`
  (`This prompt is no longer available for editing. Your changes have not
been saved.`), `409 conflict` for a stale revision (`This prompt was edited
elsewhere. Your changes have not been saved.`), `409 not_editable` (`Only
your prompts that have not started can be edited. Your changes have not
been saved.`), and `409 inactive` or `409 forbidden` (a Thread an agent
  opened) with the first message.
- `DELETE /threads/:id/queue/:promptId` removes a pending input, records
  `prompt.finished` with `status: cancelled` and `reason: queue_removed`, and
  answers `204`, also for an input already removed. A `:promptId` that is not
  a UUID answers `422 invalid_prompt` (`A promptId is required.`). The input
  being executed
  answers `409 thread_busy`, an unknown one `409 thread_unknown_prompt`, a
  Thread an agent opened `409 thread_forbidden`, and a terminal or closing
  Thread `409 thread_inactive`.

### Replay

`GET /threads/:id/events?afterSequence=N` answers `{ events, lastSequence }`:
every event after the cursor, and the Thread's latest sequence
([`routes/threads.ts`](../../../bundles/foundation/transport/src/host/routes/threads.ts),
[`domain/service.ts`](../../../bundles/runtime/runtime/src/host/domain/service.ts)).
The cursor is exclusive and defaults to 0; one that is not a non-negative
integer answers `400 invalid_event_cursor`. Sequence numbers are contiguous
per Thread, not ordered across Threads. Each event is:

```text
{ projectId, threadId, promptId, sequence, type, event, createdAt }
```

Events are persisted before they are published. Their bodies include model
reasoning, provider replay, tool inputs and results, usage, and failures.
Credentials are redacted before persistence, and the characters PostgreSQL
refuses — U+0000 and an unpaired surrogate, which binary tool output can
carry — become U+FFFD, so a single binary match cannot fail a Thread
([`domain/serialization.ts`](../../../bundles/runtime/runtime/src/host/domain/serialization.ts),
[`store/records.ts`](../../../bundles/runtime/runtime/src/host/store/records.ts)).
Full prompt and event payloads are not operational logs.

A rewind appends one `history.truncated` event whose body is
`{ type: 'history.truncated', afterSequence }`; `afterSequence` is the
sequence of the last surviving event, or `0` when none survives. Subscribers
receive it before the replacement `prompt.accepted`. Sequence numbers are
never reused: later events continue above the marker, a replay cursor above
it skips the discarded range, and a client drops its local events above
`afterSequence`
([`store/threads.ts`](../../../bundles/runtime/runtime/src/host/store/threads.ts)).

### Terminals

The terminal sessions are the
[`terminal`](../../../bundles/features/terminal/README.md) bundle's
([`routes/terminals.ts`](../../../bundles/foundation/transport/src/host/routes/terminals.ts),
[`terminal/src/contracts/index.ts`](../../../bundles/features/terminal/src/contracts/index.ts)).
A session is `{ id, projectId, threadId, origin, command, cwd, startedAt,
timeoutMs, state, pty, name? }`, with `origin` `agent` or `user` and `state`
`starting`, `running` or `exited`. Terminal data is never stored in
conversation events.

- `GET /projects/:id/terminals` answers `{ items }`, the Project's sessions in
  start order. It answers `200 { items: [] }` for a Project that does not
  exist and for an `:id` that is not a UUID
  ([`terminal/src/host/registry.ts`](../../../bundles/features/terminal/src/host/registry.ts)).
- `POST /threads/:id/terminals` opens a bash PTY in the Thread's working
  directory, bringing its Project back first, and answers `201` with the
  session. `cols` and `rows` are optional integers 1–1000
  (`422 invalid_terminal` otherwise); a missing, finished or closing Thread,
  or a Project without a sandbox, answers `409 terminal_unavailable`.
- `GET /terminals/:id?after=N` answers `{ terminal, output, offset,
truncated }`: the output after the UTF-16 offset `after` (default 0), the
  offset after it, and whether the cursor is older than the retained output.
  A cursor that is not a non-negative integer answers `422 invalid_cursor`,
  and a session that does not exist, a malformed `:id` included,
  `404 terminal_missing`.
- `POST /terminals/:id/input` takes `{ data }` of at most 65536 characters
  (`422 invalid_input` otherwise); `POST /terminals/:id/resize` takes
  `{ cols, rows }`, both 1–1000 (`422 invalid_size` otherwise). Both answer
  `204`, or `404 terminal_missing` (`Terminal no longer exists.`) when the
  session has no running process.
- `DELETE /terminals/:id` stops and removes the session and answers `204`
  whether or not it existed.

### The screen relay

The `screen-relay` bundle relays every request under `/screen/<token>/` to
the upstream the `screen` bundle exposed for that session token, HTTP
requests and WebSocket upgrades alike
([`screen-relay/src/host/relay.ts`](../../../bundles/features/screen-relay/src/host/relay.ts),
[`screen-relay/src/host/index.ts`](../../../bundles/features/screen-relay/src/host/index.ts)).
The path after the token and the query reach the upstream unchanged.

- **HTTP.** The request and the upstream's answer pass with their
  hop-by-hop headers dropped, and the request's `Host` is replaced with the
  upstream's `host:port`. A path under `/screen` whose token names no
  session answers `404` with `No such screen.` (`text/plain`). The upstream
  request is aborted after 30 seconds without activity. An upstream error
  before the answer started answers `502` with `The screen upstream is
unavailable.` (`text/plain`); after the answer started, that text is
  appended to the partial answer and the answer ends.
- **Upgrades.** The handshake is sent to the upstream as a `GET` with every
  header kept except `Host`, which is replaced with the upstream's
  `host:port`, and the upstream's own handshake answer reaches the client,
  after which bytes pass both ways. An unknown token answers a raw
  `HTTP/1.1 404 Not Found` and closes the socket; an upstream that cannot be
  reached before the handshake answers a raw `HTTP/1.1 502 Bad Gateway`, and
  one that fails after it closes the socket.

Every other path is left to the REST routes, and every other upgrade to
Socket.IO.

### Command-line client

```sh
npm run doric:spawn-agent -- --url http://127.0.0.1:3000 \
  --prompt "Inspect the workspace" --terminate
```

The client creates a Project, then a Thread, submits the input, polls durable
replay every 250 ms, and prints only IDs, event metadata, and the Project SSH
URL; it fails when the prompt finishes `failed` or `cancelled` or the Thread
ends first ([`scripts/spawn-agent.mjs`](../../../scripts/spawn-agent.mjs)).
`--url` defaults to `DORIC_URL` or `http://127.0.0.1:3000`. Without
`--terminate`, the Project remains reserved; with it, the entire Project
closes after the submitted prompt ends, including any still-running
descendants. Configure `/config` and the credentials separately; the client
sends no credentials.

## Socket.IO

The host serves Socket.IO 4 on the HTTP listener of the REST API, at the
default path `/socket.io/` ([`src/index.ts`](src/index.ts)). The
[`transport`](../../../bundles/foundation/transport/README.md) bundle registers
the namespaces `/status`, `/threads` and `/projects` on that server when it
starts
([`transport/src/kernel.ts`](../../../bundles/foundation/transport/src/kernel.ts));
the kernel's own namespace, `/doric/bridge`, is the
[desktop bridge](#the-desktop-bridge). The server accepts a message of at most
8,039,084 bytes, the base64 size of the largest image attachment the runtime
keeps plus 1 MiB for the envelope around it, and closes a connection that
sends a larger one
([`src/lib/socket-buffer.ts`](src/lib/socket-buffer.ts)).

On `/status`, `/threads` and `/projects` every event flows from the host to
the client; the host handles no event a client emits there
([`sockets/status.ts`](../../../bundles/foundation/transport/src/host/sockets/status.ts),
[`sockets/workspace.ts`](../../../bundles/foundation/transport/src/host/sockets/workspace.ts)).
A payload carries no version of its own; only the `type` of an event a bundle
appends to a Thread's log names that event's version (`comments.added/v1`).
A payload may gain optional fields and the log may carry new event types; a
client ignores the fields and the types it does not know.

```ts
import { Manager } from 'socket.io-client';

const manager = new Manager('http://127.0.0.1:3000');
const status = manager.socket('/status');
const project = manager.socket('/projects', { auth: { projectId } });

// A Manager holds one socket per namespace, so every watched Thread needs a
// Manager of its own. `auth` as a function is read again on each reconnect.
let afterSequence = 42;
const thread = new Manager('http://127.0.0.1:3000').socket('/threads', {
  auth: (send) => send({ threadId, afterSequence }),
});
thread.on('thread:snapshot', ({ events }) => {
  afterSequence = events.at(-1)?.sequence ?? afterSequence;
});
thread.on('agent:event', (event) => {
  afterSequence = event.sequence;
});
```

| Namespace               | Event               | Payload                                                                                |
| ----------------------- | ------------------- | -------------------------------------------------------------------------------------- |
| `/status`               | none                | A connection only confirms that the host is reachable.                                 |
| `/threads`              | `thread:snapshot`   | `{ threadId, projectId, project, thread, events }`                                     |
| `/threads`              | `agent:event`       | One stored event `{ projectId, threadId, promptId, sequence, type, event, createdAt }` |
| `/threads`, `/projects` | `thread:updated`    | The Thread record.                                                                     |
| `/threads`, `/projects` | `thread:deleted`    | `{ projectId, threadId }`                                                              |
| `/projects`             | `project:snapshot`  | `{ projectId, project, threads, terminals }`                                           |
| `/projects`             | `project:updated`   | The Project record.                                                                    |
| `/projects`             | `project:deleted`   | `{ projectId }`                                                                        |
| `/projects`             | `terminal:snapshot` | `{ projectId, terminals }`                                                             |
| `/projects`             | `terminal:updated`  | One terminal session.                                                                  |
| `/projects`             | `terminal:output`   | `{ projectId, threadId, terminalId, data, offset }`                                    |
| `/projects`             | `terminal:removed`  | `{ projectId, threadId, terminalId }`                                                  |
| `/threads`, `/projects` | `workspace:error`   | `{ code: 'replay_failed', message: 'The snapshot could not be loaded.' }`              |

The Project and Thread records are the ones the REST API answers
([Conventions](#conventions)), a stored event is the one
[Replay](#replay) describes, and a terminal session is the one
[Terminals](#terminals) describes. In `terminal:output`, `data` is the chunk
and `offset` the UTF-16 offset after it
([`terminal/src/contracts/index.ts`](../../../bundles/features/terminal/src/contracts/index.ts)).
`thread:updated` and `thread:deleted` reach the sockets subscribed to the
Thread and those subscribed to its Project; the `project:*` and `terminal:*`
events reach the sockets subscribed to the Project. A deletion notice leaves
the connection open
([`sockets/workspace.ts`](../../../bundles/foundation/transport/src/host/sockets/workspace.ts)).

### Subscriptions

A namespace middleware reads `socket.handshake.auth`, never the query
([`sockets/workspace.ts`](../../../bundles/foundation/transport/src/host/sockets/workspace.ts)):

- `/status` has no middleware and takes no parameters.
- `/threads` takes `auth: { threadId, afterSequence? }`: `threadId` is a
  UUID, and `afterSequence` a non-negative safe integer after coercion with
  `Number()` (so `""` and `null` read as `0`), default `0`. A handshake that
  fails is refused with the `connect_error` `Invalid thread subscription.`.
- `/projects` takes `auth: { projectId }`, a UUID. A handshake that fails is
  refused with `Invalid project subscription.`.
- The handshake does not check that the Thread or Project exists: an id that
  names nothing connects, and its snapshot carries `null` for each record it
  cannot read.

A Thread subscription runs in this order:

1. The host registers the socket first, so every live event and notice
   published from then on is kept for it.
2. It reads the stored Thread, its events after `afterSequence`, and the
   Thread's Project, and emits `thread:snapshot` with the events in sequence
   order; `projectId`, `project` and `thread` are `null` when missing.
3. It emits, as `agent:event`, the live events kept since step 1 in strict
   sequence order, starting at the snapshot's last sequence plus one. An event
   at or below that sequence is dropped, and an event that arrives after a gap
   waits until the missing one arrives, so a client receives each event once
   and in order.
4. It emits the kept `thread:updated` and `thread:deleted` notices in the
   order they arrived, then forwards each new event and notice as it is
   published.

A Project subscription registers the socket the same way and opens the
Project's terminal stream, reads the Project, its Thread tree and its terminal
sessions, and emits `project:snapshot` then `terminal:snapshot` with the same
sessions. `threads` is every Thread of the Project, children included, as a
flat array linked by `parentThreadId`. The kept notices follow in arrival
order. `terminal:output` is never kept: it reaches only a socket whose
snapshot is already out, and a client reads the output it missed from
`GET /terminals/:id?after=N` ([Terminals](#terminals)). The host keeps one
terminal stream per Project while at least one socket subscribes to it and
closes it with the last one
([`sockets/workspace.ts`](../../../bundles/foundation/transport/src/host/sockets/workspace.ts),
[`sockets/terminal-feed.ts`](../../../bundles/foundation/transport/src/host/sockets/terminal-feed.ts)).

When a snapshot read fails, the host emits `workspace:error` and disconnects
the socket; the payload never carries the cause.

Clients:

- Reuse one `Manager` for `/status` and the Project subscription so they share
  one Engine.IO connection. `Manager.socket(namespace)` returns the socket the
  Manager already holds for that namespace, so one Manager carries one
  `/threads` subscription: give each watched Thread a `Manager` of its own.
  Disconnecting a namespace socket ends its subscription on the host.
- socket.io-client reconnects with the `auth` it holds, so keep
  `afterSequence` at the last received sequence: update `socket.auth` or pass
  `auth` as a function. A Project reconnection receives the whole tree again;
  each Thread's history is replayed by its own subscription.

### Prompt events

A prompt's progress travels as stored events the runtime writes: each is an
`agent:event` whose `type` is the event's kind, whose `promptId` is the
prompt, and whose `event` body starts with that same `type`
([`domain/runner.ts`](../../../bundles/runtime/runtime/src/host/domain/runner.ts),
[`store/threads.ts`](../../../bundles/runtime/runtime/src/host/store/threads.ts)).

The same log carries the runtime's other events — `agent.cancelled` and
`agent.failed` `{ type, error? }`, `queue.paused` `{ type, reason? }` (`reason`
`storage_low` when storage stops the queue), `queue.resumed`, `queue.updated`
when the Thread's running prompt changes, and the rewind marker
`history.truncated` ([Replay](#replay)) — and every event the executor writes
through its session; the runtime README lists them under
[Event streams](../../../bundles/runtime/runtime/README.md#event-streams).
A bundle that appends to a Thread's log through `events/v1` writes under a
versioned type `<bundle>.<name>/v<N>`, such as `comments.added/v1`, with its
payload alone as `event`; the runtime publishes it as `agent:event` as soon as
it is committed
([`runtime/src/host/index.ts`](../../../bundles/runtime/runtime/src/host/index.ts),
[`runtime/src/host/appends.ts`](../../../bundles/runtime/runtime/src/host/appends.ts),
[`comments/src/host/comments.ts`](../../../bundles/features/comments/src/host/comments.ts)).

- `prompt.accepted` `{ type, text, source, queued, steer? }` records each
  accepted input. `text` is the input after configured-credential redaction,
  `source` its trusted origin, and `queued` whether it waits behind other
  work; `steer` names the running prompt when the input is a steer, whose
  `queued` is always `true`.
- `prompt.queued` `{ type, first? }` follows when the input waits in the
  queue; `first: true` puts it at the front.
- `prompt.started` `{ type }` marks the start of a run, and
  `prompt.edited` `{ type, text }` an edit of a queued input.
- `prompt.finished` `{ type, status, text, source, reason? }` ends the
  prompt, with `status` `completed`, `failed` or `cancelled`. Success is
  recorded only after conversation history is saved. Use this event, not the
  inner `agent.finished`. A persistence failure instead makes the Thread
  terminal with `persistence_failed`, so a client also observes Thread state.
  `reason` is `interrupted` when the reader's stop ended the run and
  `queue_removed` when the input was removed from the queue
  ([The prompt queue](#the-prompt-queue)).
- The reader's stop (`POST /threads/:id/interrupt`) ends a running prompt with
  `prompt.finished` `status: cancelled` and `reason: interrupted`, and the
  history it wrote stays. A prompt that has not started is not running, so
  the stop leaves it without a `prompt.finished`.
- `prompt.paused` `{ type, reason }` records an interruption that leaves the
  prompt unfinished. The host writes `reason` `host_stopped` when the host
  stops during the run, `host_restarted` when a boot finds a started prompt
  whose run left no pause, and `storage_low` when storage runs low during the
  run
  ([`domain/storage-pause.ts`](../../../bundles/runtime/runtime/src/host/domain/storage-pause.ts),
  [Storage protection](#storage-protection)). It also reads `reader_stopped`
  in a stored log and treats it as a pause only the reader takes up again; it
  writes no such pause
  ([`store/progress.ts`](../../../bundles/runtime/runtime/src/host/store/progress.ts),
  [`store/types.ts`](../../../bundles/runtime/runtime/src/host/store/types.ts)).
- `prompt.resumed` `{ type, attempt, first? }` records that the host takes a
  paused prompt up again, with `attempt` counting from `1`; a reader's own
  resume of the prompt appends the same event under the prompt's `promptId`.
  A resumable prompt is unfinished: a client that sees one — no
  `prompt.finished`, and a pause or a `prompt.resumed` as its last word — can
  offer the reader `POST /threads/:id/resume`.

### Steering and delivered results

`POST /threads/:id/steer` ([Request rules](#request-rules)) answers
`{ status, promptId }` with the steer's own id. With `steered`, the running
prompt takes the input in at its next safe point — after the tool batch in
flight, or before its final answer — and `interrupt: true` also aborts its
current step so it continues with the steer at once. With `queued`, no run
takes it in — the named prompt is not the one running, the queue is stopped,
the Thread is stopping or pausing, or storage is low — and the input is
queued at the back like an ordinary prompt; when the run ends while the steer
is being accepted, the steer waits at the front of the queue instead
([`domain/runner.ts`](../../../bundles/runtime/runtime/src/host/domain/runner.ts)).

The steer is recorded as `prompt.accepted` with `steer` naming the running
prompt. Taking it in appends `prompt.steered` `{ type, promptId, text,
source }` under the steer's own id, where `promptId` is the running prompt
([`domain/session.ts`](../../../bundles/runtime/runtime/src/host/domain/session.ts)).
A steer the run ends without reading returns to the front of the queue with
`prompt.queued` `first: true`.

Delegated results and background terminal results are delivered the same way,
without a request: a Thread that is running takes them in as steers of its
active prompt at the next safe point, without interrupting it; otherwise they
are queued. They can start further model and tool activity
([`domain/runner.ts`](../../../bundles/runtime/runtime/src/host/domain/runner.ts)).

## Docker deployment details

[`.Dockerfile`](.Dockerfile) builds the host from the repository root. Every
stage starts from `node:22-bookworm-slim` pinned by digest, and every archive
or binary it fetches with `curl` is checked against a recorded SHA-256, so a
changed one fails the build. Of the Debian packages, only those the host
runs sandboxes with are pinned by version — nftables and openssh-client in
`docker-runtime`, and e2fsprogs, iproute2, nftables, openssh-client, skopeo
and socat in `runtime`; the build tools, `ca-certificates`, `curl` and the
other packages install the versions the unpinned `apt-get update` finds.
Its stages:

- `agent-builder` copies `package.json`, `package-lock.json`, `nx.json`,
  `tsconfig.json`, `tsconfig.base.json` and the trees `app`, `bundles`,
  `packages` and `tools`, and installs npm 11.13.0. It runs
  `npm ci --ignore-scripts`, so no lifecycle script runs, then Nx's
  `post-install` step itself; generates the Prisma client; compiles
  `packages/storage` and the host with `tsc --build`; writes the platform
  schemas; and runs
  `NX_DAEMON=false npx nx run doric-host:build-bundles --skip-nx-cache`, the
  target a local build runs, with no Nx daemon and no Nx cache.
  `build-bundles` builds every Nx project tagged `type:bundle`, then
  `stage --all` stages every directory `bundles/<group>/<id>` that holds a
  `manifest.json` into `app/backend/doric-host/dist/bundles`
  ([`project.json`](project.json),
  [`build/cli.ts`](../../../packages/bundle/src/build/cli.ts)). A failing
  bundle build fails the image build. It then moves `dist/index.*` and
  `dist/lib` under `app/backend/doric-host/dist/src`, the path the host's
  start command names.
- `agent-runtime` holds the built `/workspace` on the base image. Compose's
  `migrate` service runs it.
- `docker-runtime` adds nftables, the OpenSSH client and a static Dropbear
  (`DROPBEAR_2026.94`, compiled in `dropbear-tools`) at
  `/opt/doric/firecracker/dropbearmulti`, and sets `DORIC_SANDBOX_SSH=true`.
  Compose's `docker` service runs it.
- `runtime`, the final stage, adds the pinned Debian packages e2fsprogs,
  iproute2, nftables, openssh-client, skopeo and socat, umoci 0.6.0 at
  `/usr/local/bin/umoci`, and the Firecracker assets at the paths the
  Firecracker provider reads by default
  ([`firecracker-sandbox/src/lib/firecracker.ts`](../../../packages/firecracker-sandbox/src/lib/firecracker.ts)):
  the VMM and jailer 1.16.1 from the x86_64 release at
  `/usr/local/bin/firecracker` and `/usr/local/bin/jailer`; the Linux 6.18
  guest kernel, compiled monolithic in `kernel-builder`, at
  `/opt/doric/firecracker/vmlinux`; the initramfs assembled in
  `initramfs-builder` from a static BusyBox 1.37.0, Dropbear and the boot
  scripts in [`firecracker/`](firecracker), at
  `/opt/doric/firecracker/initramfs.cpio`; and the static Dropbear at
  `/opt/doric/firecracker/dropbearmulti`. It also copies the static BusyBox to
  `/opt/doric/firecracker/busybox`. It creates the state and cache
  directories `/var/lib/doric/firecracker` and `/var/cache/doric/firecracker`
  with mode `0700` and sets `DORIC_HOST=0.0.0.0`, `DORIC_PORT=3000` and
  `DORIC_SANDBOX_SSH=true`. Compose's `firecracker` service runs it.

Each host stage runs `node app/backend/doric-host/dist/src/index.js` and
exposes port 3000.

The build context is filtered by [`.dockerignore`](../../../.dockerignore),
which excludes `.git`, `.nx`, `.env` and `.env.*` at the repository root,
every `dist`, `dist-*` and `node_modules` directory, every `*.log`,
`models/**/artifact` and `tmp`. Its `.env` patterns match only at the root, so
`COPY app ./app` copies `app/backend/doric-host/.env`, the file Compose reads
the deploy credentials from, into `agent-builder`, and with `/workspace` into
the `agent-runtime`, `docker-runtime` and `runtime` images.

The Compose profiles ([`compose.yaml`](compose.yaml)) need a Linux Docker
host: both host services share the host's network namespace. The `docker`
profile hands its host the Docker socket and the `NET_ADMIN` capability for
the nftables firewall the Docker provider manages
([`docker-sandbox/src/lib/host.ts`](../../../packages/docker-sandbox/src/lib/host.ts)).
The `firecracker` profile hands its host privileged mode, `/dev/kvm`,
`/dev/net/tun`, the cgroup filesystem read-write and its state and cache
volumes, and no Docker socket. The Firecracker provider runs the jailer as
uid and gid 0 by default, and its preflight refuses a host that is not Linux
x86_64, lacks read/write `/dev/kvm` or `/dev/net/tun`, cgroup v2, a working
`nft`, or IP forwarding, lacks a Firecracker asset or the state and cache
directories at their paths, runs another Firecracker or jailer than 1.16.1, or
lacks `debugfs`, `ip`, `mkfs.ext4`, `mount`, `skopeo`, `ssh`, `ssh-keygen`,
`truncate`, `umoci` or `umount`
([`firecracker-sandbox/src/lib/preflight.ts`](../../../packages/firecracker-sandbox/src/lib/preflight.ts),
[`firecracker-sandbox/src/lib/firecracker.ts`](../../../packages/firecracker-sandbox/src/lib/firecracker.ts),
[`firecracker-sandbox` README](../../../packages/firecracker-sandbox/README.md)).
That profile is a privileged harness for development and e2e runs, not a
production isolation boundary. Both host services mount the `postgres-data`
volume read-only at `/var/lib/doric/postgresql` and set `DORIC_STORAGE_PATH`
to it, so the host measures the database's filesystem
([Storage protection](#storage-protection)).

### The sandbox image

The Docker profile runs sandboxes from the image built from
[`.sandbox.Dockerfile`](.sandbox.Dockerfile), on `node:22-bookworm`. On top of
the base image's Git it adds, each checked by the build:

- the GitHub CLI 2.101.0, from its checksum-verified release, for `amd64` and
  `arm64`;
- the runtime libraries Electron needs, with Xvfb for headless runs, and the
  xpra screen server with its HTML5 client under `/usr/share/xpra/www`, so a
  sandbox builds desktop apps and serves its Project screen;
- Debian's Docker engine and CLI, so a sandbox builds the images its Project
  describes once a daemon is reachable;
- esbuild 0.28.2, the version the
  [`papercraft`](../../../bundles/features/papercraft/package.json) bundle
  depends on, under `/opt/doric/bundler`, so component previews bundle inside
  the sandbox; on an image without it they bundle on the host, reading each
  file through it
  ([`papercraft/src/host/sandbox.ts`](../../../bundles/features/papercraft/src/host/sandbox.ts)).

The image is a deployment choice read from the environment: both sandbox
providers take `DORIC_SANDBOX_IMAGE` and default to the plain
`node:22-bookworm`
([`docker/src/host/sandbox.ts`](../../../bundles/sandboxes/docker/src/host/sandbox.ts),
[`firecracker/src/host/sandbox.ts`](../../../bundles/sandboxes/firecracker/src/host/sandbox.ts)).
Compose's `docker` service passes `DORIC_SANDBOX_IMAGE` with the default
`doric-sandbox:local`. Build the tag before `up`:

```sh
# from the repository root, before `docker compose --profile docker up`
docker build -f app/backend/doric-host/.sandbox.Dockerfile -t doric-sandbox:local app/backend/doric-host
```

The Docker provider pulls an image only when the daemon does not hold it, so a
tag that was never built fails the pool's image pull rather than falling back
to the plain Node image
([`docker-sandbox/src/lib/provider.ts`](../../../packages/docker-sandbox/src/lib/provider.ts)).

The Firecracker provider reads no local Docker tag. It copies the image with
`skopeo` from `docker://<image>` without credentials, as the `linux/amd64`
manifest, so the image must be an anonymous public OCI image; a reference that
is empty, holds `://` or holds whitespace fails with `Firecracker image must
be a public OCI registry reference`
([`firecracker-sandbox/src/lib/image.ts`](../../../packages/firecracker-sandbox/src/lib/image.ts)).
This image serves Firecracker only once an `amd64` build of it is published to
a public registry and `DORIC_SANDBOX_IMAGE` names it. Compose's `firecracker`
service passes no `DORIC_SANDBOX_IMAGE`, so under Compose it runs
`node:22-bookworm` ([`compose.yaml`](compose.yaml)).

The sandbox's Docker CLI reaches a daemon only where the sandbox is given
`/var/run/docker.sock` or the privileges `dockerd` needs. With
`DORIC_SANDBOX_DOCKER_SOCKET=true`, and when the provider reaches the daemon
over a Unix socket, the Docker provider mounts that socket at
`/var/run/docker.sock` in every Project sandbox; any other value, or a
connection that is not a Unix socket, leaves it out
([`docker/src/host/sandbox.ts`](../../../bundles/sandboxes/docker/src/host/sandbox.ts),
[`docker-sandbox/src/lib/docker.ts`](../../../packages/docker-sandbox/src/lib/docker.ts),
[`docker-sandbox/src/lib/provider.ts`](../../../packages/docker-sandbox/src/lib/provider.ts)).
Compose passes `false` unless the environment file sets the variable, because
a sandbox holding the socket drives the host's Docker daemon;
[`.env.example`](.env.example) sets it to `true` for local development. Keep
it off where Projects are not yours.

### Build traps

Two traps break the image build or the deployed catalog:

- Every bundle must be an Nx project tagged `type:bundle` and live in
  `bundles/<group>/<id>` with a `manifest.json`. `build-bundles` builds the
  tagged projects; `stage --all` stages the manifest directories. A manifest
  whose project has no tag is not built, so `stage` fails on its missing
  `dist/manifest.json` and the image build fails (the `.dockerignore` excludes
  `**/dist`, so no local build hides it). A tagged project outside
  `bundles/<group>/<id>` is built but never staged, and nothing reports it:
  the bundle is not in `dist/bundles`, so the host never loads it
  ([`project.json`](project.json),
  [`build/cli.ts`](../../../packages/bundle/src/build/cli.ts)).
- `package-lock.json` must be resolvable by npm 11: `agent-builder` installs
  npm 11.13.0 before `npm ci`
  ([`.Dockerfile`](.Dockerfile)). A lock rewritten by npm 10, the npm
  `node:22-bookworm-slim` ships, fails `npm ci` with
  `Missing: <package> from lock file`; regenerate it with
  `npx npm@11 install --package-lock-only`.

### Rotating the PostgreSQL password

To replace the PostgreSQL password of a deployment without losing data, alter
the role inside the `postgres` container over its loopback address, which the
PostgreSQL image trusts, instead of recreating the volume. The container is
`<project>-postgres-1`, where the Compose project is `doric-sandbox`, or
`doric` when started with `npm run doric:docker:build`; the role and database
are your `DORIC_POSTGRES_USER` and `DORIC_POSTGRES_DB`:

```sh
docker exec -it doric-sandbox-postgres-1 \
  psql -U doric -h 127.0.0.1 -d doric -c "ALTER ROLE doric WITH PASSWORD 'NEW'"
```

Then set `DORIC_POSTGRES_PASSWORD` in `app/backend/doric-host/.env` and
recreate the host service: `migrate` and both host services build
`DORIC_DATABASE_URL` from it ([`compose.yaml`](compose.yaml)).

## Provider kinds

The provider kinds are the ones the provider bundles of the default
[`composition.json`](composition.json) register:

| Kind         | Serves                                                                                                           | Advertised |
| ------------ | ---------------------------------------------------------------------------------------------------------------- | ---------- |
| `openai`     | Any endpoint that answers the OpenAI Responses API.                                                              | yes        |
| `openrouter` | OpenRouter Chat Completions with curated model profiles, live capability discovery and structured-output repair. | yes        |
| `claude`     | Anthropic Messages through a Claude Code subscription login.                                                     | yes        |
| `codex`      | The ChatGPT Codex Responses backend.                                                                             | no         |

Each kind is defined in its bundle's `src/host/kind.ts`
([`openai`](../../../bundles/providers/openai/src/host/kind.ts),
[`openrouter`](../../../bundles/providers/openrouter/src/host/kind.ts),
[`claude`](../../../bundles/providers/claude/src/host/kind.ts),
[`codex`](../../../bundles/providers/codex/src/host/kind.ts)).
`GET /providers/kinds` lists the advertised kinds, and a kind that is not
advertised is still accepted by `POST /providers/models` and `PUT /config`
([Configuration and providers](#configuration-and-providers)).

`prisma migrate deploy` refuses a database whose `provider_configuration`
table holds a row of kind `lmstudio` or `lmstudio-openai`: the migration
`20261008000000_consolidate_providers` raises `Replace LM Studio providers
with OpenAI Responses or OpenRouter in the previous Doric version before
applying this migration.` and no later migration is applied
([`migration.sql`](../../../bundles/foundation/postgres/prisma/migrations/20261008000000_consolidate_providers/migration.sql)).

## Persistence and security

### Database

PostgreSQL holds everything durable. The `postgres` bundle reaches it: it
provides `storage.backend/v1`, on which the core builds `storage/v1`, and
`secrets.backend/v1`, on which the core builds `secrets/v1`, and the shipped
[`composition.json`](composition.json) chooses it for both
([`postgres/src/host/postgres.ts`](../../../bundles/foundation/postgres/src/host/postgres.ts)).
The [postgres bundle README](../../../bundles/foundation/postgres/README.md)
gives every method, lock and limit of those two backends.

**Schema and migrations.** The Prisma schema and the migrations live in the
bundle
([`schema.prisma`](../../../bundles/foundation/postgres/prisma/schema.prisma),
[`migrations/`](../../../bundles/foundation/postgres/prisma/migrations)), one
`migration.sql` per directory, applied in name order.
[`prisma.config.ts`](prisma.config.ts) points the Prisma CLI at both, with the
datasource `DORIC_DATABASE_URL`, or
`postgresql://doric:doric@127.0.0.1:5432/doric` when it is unset.
`npx nx run doric-host:migrate` runs `prisma migrate deploy` with that config
([`project.json`](project.json)), and the Compose `migrate` service runs the
same command before either host service starts
([`compose.yaml`](compose.yaml)). Startup never applies a migration. Prisma
records each applied migration in its own `_prisma_migrations` table and
applies only the ones not recorded there.

The migrations leave these tables
([`migrations/`](../../../bundles/foundation/postgres/prisma/migrations)):

| Table                  | Columns                                                                                                                                                | Keys and constraints                                                                                                                                                                    |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `credential`           | `id uuid`, `kind text`, `name text`, `username text?`, `email text?`, `secret text?`, `created_at timestamptz(3)`, `updated_at timestamptz(3)`         | primary key `id`; unique `(kind, name)`                                                                                                                                                 |
| `storage_meta`         | `key text`, `value jsonb`                                                                                                                              | primary key `key`                                                                                                                                                                       |
| `storage_type`         | `type text C`, `indexes jsonb`, `declared_at timestamptz(3)`                                                                                           | primary key `type`                                                                                                                                                                      |
| `storage_document`     | `type text C`, `id text C`, `revision integer`, `value jsonb`, `updated_at timestamptz(3)`                                                             | primary key `(type, id)`; check `revision > 0`                                                                                                                                          |
| `storage_index_entry`  | `type text C`, `index_name text C`, `key bytea`, `document_id text C`, `unique_key boolean`                                                            | primary key `(type, index_name, key, document_id)`; unique `(type, index_name, key) WHERE unique_key`; index `(type, document_id)`; `(type, document_id)` references `storage_document` |
| `storage_stream`       | `stream text C`, `last_sequence integer` (default `0`)                                                                                                 | primary key `stream`                                                                                                                                                                    |
| `storage_stream_entry` | `stream text C`, `sequence integer`, `value jsonb`, `created_at timestamptz(3)`                                                                        | primary key `(stream, sequence)`; `stream` references `storage_stream`                                                                                                                  |
| `storage_commit`       | `position bigint`, `documents jsonb`, `streams jsonb`, `truncated jsonb` (default `[]`), `dropped jsonb` (default `[]`), `committed_at timestamptz(3)` | primary key `position`                                                                                                                                                                  |
| `storage_truncation`   | `stream text C`, `position bigint`, `after_sequence integer`, `at_sequence integer`                                                                    | primary key `(stream, position)`; `stream` references `storage_stream`; `position` references `storage_commit`                                                                          |
| `storage_blob`         | `hash text` (`sha256:<hex>`), `bytes bytea`, `size integer`, `created_at timestamptz(3)`                                                               | primary key `hash`                                                                                                                                                                      |

`text C` is `text COLLATE "C"`, so keys compare bytewise; `?` marks a nullable
column, and every other column is `NOT NULL`. Every `timestamptz(3)` column
defaults to the current time except `credential.updated_at`, which the client
sets at each write; `credential.id` has no default, so the writer gives the
UUID. Every foreign key is `ON UPDATE CASCADE` and `ON DELETE CASCADE`, except
`storage_truncation.position`, which is `ON DELETE RESTRICT`. No other table,
function, trigger or enum type remains.

**Who reads and writes them.** The storage backend reads and writes the
`storage_*` tables with raw SQL
([`storage/`](../../../bundles/foundation/postgres/src/host/storage/)), and the
secrets backend reads and writes `credential` through the generated Prisma
client
([`secrets/table.ts`](../../../bundles/foundation/postgres/src/host/secrets/table.ts)).
No other code touches the database. The host stores these records through
`storage/v1`:

| Record                                 | Document id or stream                                   | Indexes                           | Defined in                                                                                      |
| -------------------------------------- | ------------------------------------------------------- | --------------------------------- | ----------------------------------------------------------------------------------------------- |
| `core.settings/v1` document            | the settings id, such as `host-config.configuration/v1` | none                              | [`core/src/contracts/storage.ts`](../../../bundles/foundation/core/src/contracts/storage.ts)    |
| `core.settings-generation/v1` document | `global`                                                | none                              | [`core/src/contracts/storage.ts`](../../../bundles/foundation/core/src/contracts/storage.ts)    |
| `runtime.project/v1` document          | the Project id                                          | `byCreated`, `byOpen`             | [`runtime/src/contracts/storage.ts`](../../../bundles/runtime/runtime/src/contracts/storage.ts) |
| `runtime.thread/v1` document           | the Thread id                                           | `byProject`, `byParent`, `byOpen` | [`runtime/src/contracts/storage.ts`](../../../bundles/runtime/runtime/src/contracts/storage.ts) |
| `runtime.history/v1` document          | `<threadId>:<part>`, one provider-history part          | `byThread`                        | [`runtime/src/contracts/storage.ts`](../../../bundles/runtime/runtime/src/contracts/storage.ts) |
| `runtime.attachment/v1` document       | `<threadId>:<attachmentId>`; the bytes are a blob       | `byProject`, `byThread`, `byBlob` | [`runtime/src/contracts/storage.ts`](../../../bundles/runtime/runtime/src/contracts/storage.ts) |
| `runtime.migration/v1` document        | `legacy-prisma`                                         | none                              | [`runtime/src/contracts/storage.ts`](../../../bundles/runtime/runtime/src/contracts/storage.ts) |
| `mcp.server/v1` document               | the server id                                           | `byProject`                       | [`mcp/src/host/store.ts`](../../../bundles/features/mcp/src/host/store.ts)                      |
| Thread event stream                    | `runtime.thread.events/<threadId>`                      | none                              | [`runtime/src/host/store/events.ts`](../../../bundles/runtime/runtime/src/host/store/events.ts) |

`storage_meta` holds two reserved records. `identity` is
`{ hostId, storageGeneration }`, written by the first `identity` call
([`identity.ts`](../../../bundles/foundation/postgres/src/host/storage/identity.ts));
a desktop discards its local history snapshots when `storageGeneration`
changes
([`history/src/desktop/index.ts`](../../../bundles/desktop/history/src/desktop/index.ts)).
`coalesced-thread-deltas` records that the stored Thread event streams keep
one entry per run of consecutive deltas, with its counts; the migration that
writes it does nothing when the record exists
([`20261021000000_coalesce_thread_deltas`](../../../bundles/foundation/postgres/prisma/migrations/20261021000000_coalesce_thread_deltas/migration.sql)).

**A new database.** `migrate` over an empty database leaves the
`OPENROUTER_API_KEY` credential (kind `API_TOKEN`, id
`00000000-0000-4000-8000-000000000002`, empty secret), the default
configuration document, which names that credential as the token of the
`openrouter` provider, the settings generation `global`, the
`runtime.migration/v1` document `legacy-prisma` with zero counts, two
`storage_commit` rows, so the host's first commit takes position 3, and the
`coalesced-thread-deltas` record. The
[postgres bundle README](../../../bundles/foundation/postgres/README.md#rows-the-migrations-leave)
gives their values.

**Retention.** Nothing expires with time; a record stays until the code below
removes it.

- Deleting a Thread deletes its documents and those of its descendant
  Threads, with their history parts and attachment records, and drops their
  event streams
  ([`store/threads.ts`](../../../bundles/runtime/runtime/src/host/store/threads.ts));
  deleting a Project does the same for every Thread it holds
  ([`store/projects.ts`](../../../bundles/runtime/runtime/src/host/store/projects.ts)).
  Dropping a stream deletes its entries and truncation marks.
- A rewind truncates the Thread's stream above the rewound sequence. The
  stream's counter never decreases, so a sequence is never reused, and the
  truncation leaves a mark under its commit position
  ([`commit.ts`](../../../bundles/foundation/postgres/src/host/storage/commit.ts)).
- A blob is deleted once no `runtime.attachment/v1` record names it
  ([`store/attachments.ts`](../../../bundles/runtime/runtime/src/host/store/attachments.ts)).
- `storage_commit`, the commit feed, and `storage_type` are never pruned; a
  credential stays until `DELETE /credentials/:id`.

**The startup check.** The `database_client` start step connects and then
looks for the tables `project`, `thread` and `thread_event`: when all three
exist and one of them holds a row, startup fails at `database_client` with
`Legacy Project and Thread data has not been migrated; run prisma migrate deploy.`
When the database cannot answer that check, startup goes on, and the first
query that needs the database fails instead
([`database.ts`](../../../bundles/foundation/postgres/src/host/database.ts),
[`start.ts`](../../../bundles/foundation/postgres/src/host/start.ts)).

**When `migrate` stops.** A migration that finds data it cannot carry raises
an exception and rolls its own transaction back; Prisma records the migration
as failed and applies nothing after it. The exceptions are:

- `Replace LM Studio providers with OpenAI Responses or OpenRouter in the previous Doric version before applying this migration.`
  ([`20261008000000_consolidate_providers`](../../../bundles/foundation/postgres/prisma/migrations/20261008000000_consolidate_providers/migration.sql));
- `A stored provider kind is not supported; replace it in the previous Doric version before applying this migration.`,
  `Stored Doric model role is missing: EXECUTION` and
  `The Doric configuration conversion could not be verified.`
  ([`20261009000000_generic_storage`](../../../bundles/foundation/postgres/prisma/migrations/20261009000000_generic_storage/migration.sql));
- `The Project and Thread migration could not be verified: …`
  ([`20261010000000_runtime_documents`](../../../bundles/foundation/postgres/prisma/migrations/20261010000000_runtime_documents/migration.sql));
- `The Thread delta coalescing could not be verified: …`
  ([`20261021000000_coalesce_thread_deltas`](../../../bundles/foundation/postgres/prisma/migrations/20261021000000_coalesce_thread_deltas/migration.sql));
- `Legacy table "<name>" holds <n> rows; …`, while `project`, `thread` or
  `thread_event` holds a row
  ([`20261117000000_drop_legacy_runtime_tables`](../../../bundles/foundation/postgres/prisma/migrations/20261117000000_drop_legacy_runtime_tables/migration.sql)).

No migration can be reversed: back up a database whose data matters
(`pg_dump`) before `migrate`. While a migration is recorded as failed,
`migrate` refuses to run; after correcting the data,
`npx prisma migrate resolve --rolled-back <migration> --config app/backend/doric-host/prisma.config.ts`
clears the record and `npx nx run doric-host:migrate` applies it again.

**Recreating an incompatible database.** A database these migrations cannot
bring to the schema above is incompatible: `migrate` stops on it, or the
startup check refuses it. Neither the host nor `migrate` ever resets or
deletes a database; an existing incompatible development database is
recreated explicitly by its operator, which deletes all its data. With the
host stopped, either:

- reset it in place with the Prisma CLI, which deletes everything in the
  database of `DORIC_DATABASE_URL` and applies every migration (it asks for
  confirmation; `--force` skips it):

  ```sh
  export DORIC_DATABASE_URL=postgresql://USER:PASSWORD@127.0.0.1:5432/DB
  npx prisma migrate reset --config app/backend/doric-host/prisma.config.ts
  ```

- or, with Compose, delete the PostgreSQL volume and start again, so
  `postgres` creates an empty database and `migrate` applies every migration
  ([`compose.yaml`](compose.yaml)). From `app/backend/doric-host`:

  ```sh
  docker compose --profile docker down
  docker volume rm doric-sandbox_postgres-data
  docker compose --profile docker up -d
  ```

  The volume is `<project>_postgres-data`: `doric_postgres-data` for the
  project `doric` of `npm run doric:docker:build`
  ([With Docker Compose](#with-docker-compose)).

### Network exposure

The API is unauthenticated. Keep it on an isolated trusted network, especially
because SSH responses and execution replay contain sensitive material. Provider
credential values belong in the credential store, never configuration JSON or
client requests.

### Credentials

The host keeps every secret it holds in one credential store, one
`credential` row per named credential. A credential's kind fixes its fields
([`basic/secrets.ts`](../../../packages/bundle/src/contracts/basic/secrets.ts),
[`git/src/host/credentials.ts`](../../../bundles/features/git/src/host/credentials.ts)):

| Kind                | Fields                          | Registered by    | Use                                                |
| ------------------- | ------------------------------- | ---------------- | -------------------------------------------------- |
| `API_TOKEN`         | `secret`                        | the platform     | Authentication: a provider key, the GitHub token.  |
| `USERNAME_PASSWORD` | `username`, `secret`            | the platform     | Authentication with a name.                        |
| `GIT`               | `username`, `email` (no secret) | the `git` bundle | The identity the agent's git commands commit with. |

The REST API's [Credentials](#credentials) routes manage them, and
[the credentials feature](../../../docs/features/credentials.md) describes how
the product uses them.

**Encryption.** A non-empty secret is stored as the envelope
`v1:<nonce>:<tag>:<ciphertext>`: AES-256-GCM under `DORIC_CREDENTIAL_KEY`,
with a random 12-byte nonce, the 16-byte authentication tag and the UTF-8
ciphertext, each in base64. An empty secret is stored as `''`, unencrypted
([`envelope.ts`](../../../bundles/foundation/postgres/src/host/secrets/envelope.ts)).
Secrets cross `secrets.backend/v1` in plaintext and are sealed only inside the
postgres bundle; no route answers a secret.

`DORIC_CREDENTIAL_KEY` has no default. Generate it with
`openssl rand -base64 32` and keep it: a stored secret opens only under the
key that sealed it. The postgres bundle reads the key at the first credential
read or write and keeps the cipher it builds
([`secrets/backend.ts`](../../../bundles/foundation/postgres/src/host/secrets/backend.ts)):

- **Malformed** (not exactly 32 bytes of base64): every credential read and
  write fails with `DORIC_CREDENTIAL_KEY must be 32 base64-encoded bytes.`,
  so startup fails at `credential_activation`
  ([Configuration](#configuration)).
- **Unset or blank**: reads succeed while no stored credential holds a
  non-empty secret; once one does, reading it fails with
  `credential_key_required`
  (`DORIC_CREDENTIAL_KEY is required while a stored credential holds a secret.`),
  so startup fails at `credential_activation`. Storing any secret, `''`
  included, fails with `credential_storage_unavailable`
  (`DORIC_CREDENTIAL_KEY is required to store a credential secret.`), which
  the API answers with `503`.
- **Another key** than the one that sealed a secret, or a stored value that
  is not a `v1` envelope: reading it fails with `credential_unreadable`; an
  unreadable row is an error, never an empty secret.

**Redaction.** The core replaces every occurrence of each non-empty stored
secret with `[REDACTED]` in an event before it is written
([`events/facade.ts`](../../../bundles/foundation/core/src/host/events/facade.ts),
[`secrets/cache.ts`](../../../bundles/foundation/core/src/host/secrets/cache.ts))
and in every log line
([`shared/log.ts`](../../../bundles/foundation/core/src/shared/log.ts),
[`shared/redact.ts`](../../../bundles/foundation/core/src/shared/redact.ts)).
The runtime also redacts a token it has written into a sandbox, whether or not
the store still holds it
([`domain/service.ts`](../../../bundles/runtime/runtime/src/host/domain/service.ts),
[`domain/redactor.ts`](../../../bundles/runtime/runtime/src/host/domain/redactor.ts)).

### Git and GitHub inside the sandbox

The host applies the Git identity and the GitHub token to a Project's sandbox
([`git-credentials.ts`](../../../bundles/runtime/runtime/src/host/domain/git-credentials.ts)):

- `git config --global` `user.name` and `user.email` for the identity;
- when a token is configured, `credential.helper store` plus a
  `~/.git-credentials` written 0600 with
  `https://<username>:<token>@github.com`, and a `~/.config/gh/hosts.yml`
  written 0600 so the token authenticates the sandbox's `gh`. The username is
  the identity's, or `oauth2` without one.

The credentials the configuration chooses are used. Without a choice, the
identity is the one `GIT` credential, and the token the one `API_TOKEN`
credential no provider names; none leaves that half off. A chosen credential
that is missing, or several candidates, leave that half off with the warning
`A credential was not applied: <reason>`, and the prompt goes on
([`git-credentials.ts`](../../../bundles/runtime/runtime/src/host/domain/git-credentials.ts)).
The host applies the pair when a lease is acquired and again whenever the
current pair differs from the one the sandbox holds, because the chosen
credentials follow the current configuration while every other value stays
captured per Project
([`domain/service.ts`](../../../bundles/runtime/runtime/src/host/domain/service.ts)).
The token travels only through the sandbox process environment, so it never
appears in a command argument, a tool argument or result, an event, or a log
line; a write that fails is the warning `Git credentials could not be applied`,
naming the Project and nothing else.

## Storage protection

The runtime checks the filesystem that holds the database before it dispatches
each prompt and every three seconds while a run executes
([`storage-pressure.ts`](../../../bundles/runtime/runtime/src/host/domain/storage-pressure.ts),
[`runner.ts`](../../../bundles/runtime/runtime/src/host/domain/runner.ts)). The
measurement is `statfs` of `DORIC_STORAGE_PATH`, the current directory when
unset, and makes no database round trip
([`health.ts`](../../../bundles/foundation/postgres/src/host/storage/health.ts)).

- At **10% free blocks or less**, or when the path cannot be measured,
  execution pauses: the run is aborted, and the Thread becomes `ready` with
  `queuePaused` and the error code `storage_low`, whose message is
  `Execution paused: storage is low or unavailable. Free disk space above 10% and resume the queue.`
  ([`storage-pause.ts`](../../../bundles/runtime/runtime/src/host/domain/storage-pause.ts)).
  Queued inputs stay accepted.
- A disk-full error from PostgreSQL (`53100`) or the operating system
  (`ENOSPC`) pauses the same way, independently of the measurement.
- Recovery never starts on its own. Free space above 10%, then resume the
  queue (`POST /threads/:id/queue/resume`); while storage is still low, the
  resume answers `409 thread_storage_low`.

Compose sets `DORIC_STORAGE_PATH=/var/lib/doric/postgresql` and mounts its
PostgreSQL volume there read-only ([`compose.yaml`](compose.yaml)). A native
run measures the current directory unless the variable points at the
database's filesystem, and a local path does not measure a remote PostgreSQL
server: a remote deployment needs a mount of that filesystem for proactive
protection.

When the disk is already full, the pause keeps the unsaved provider history
and the pause events in memory, and a resume first writes them; until they
are saved, the resume answers `409 thread_storage_low`
([`storage-pause.ts`](../../../bundles/runtime/runtime/src/host/domain/storage-pause.ts),
[`runner.ts`](../../../bundles/runtime/runtime/src/host/domain/runner.ts)).
Keep that host process alive while freeing space: a process that exits loses
what it holds in memory.

## Validation

Run each command from the repository root; the host's targets are in
[`project.json`](project.json).

| Command                                          | What it does and checks                                                                                                                                          |
| ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npx nx run doric-host:build`                    | Builds every project the host depends on, runs `build-bundles`, then compiles `src/` with `tsc` into `dist/`; a type error fails it.                             |
| `npx nx run doric-host:build-bundles`            | Builds every Nx project tagged `type:bundle` and stages every bundle into `dist/bundles`; never cached.                                                          |
| `npx nx run doric-host:test`                     | Builds the host, compiles `src/` and `tests/` into `dist-tests/` (`tsconfig.spec.json`), and runs `dist-tests/tests/*.test.js` with `node --test`; never cached. |
| `npx nx run doric-host:migrate`                  | Applies the pending migrations to `DORIC_DATABASE_URL` ([Database](#database)); it checks nothing else.                                                          |
| `npx nx run doric-host-e2e:e2e`                  | Builds the host and runs the full host workflow against a disposable database and Docker sandbox, scripting only the external LLM.                               |
| `npx nx run agent:test`                          | The reusable agent loop the host depends on.                                                                                                                     |
| `node --test scripts/tests/spawn-agent.test.mjs` | The [command-line client](#command-line-client).                                                                                                                 |

`doric-host:test` covers ([`tests/`](tests)): the boot and stop of the
compiled host and its startup stages, the bundle composition and its order,
what a desktop window may call (against
[`bridge-exposure.snapshot.json`](tests/bridge-exposure.snapshot.json)), the
desktop bridge, the sandbox provider choice, the Socket.IO buffer size, the
credential adapter and its reference races, the migrations over seeded
databases, persistence, and that no log line carries a resolved secret.

The database cases need `DORIC_TEST_DATABASE_URL`, a connection to a dedicated
PostgreSQL server whose role may create databases and schemas: each case
creates its own and drops it afterwards
([`helpers/host.ts`](tests/helpers/host.ts),
[`helpers/persistence-fixture.ts`](tests/helpers/persistence-fixture.ts)).
Without it, those cases skip. `DORIC_TEST_SANDBOX=true` also runs the cases
that start a sandbox. `doric-host-e2e:e2e` requires both variables and fails
before running any test without them
([`doric-host-e2e/project.json`](../doric-host-e2e/project.json)).
