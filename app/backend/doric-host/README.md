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
- [Provider upgrades](#provider-upgrades)
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

### Routes

Configuration, credentials and providers:

| Method    | Path                | Success   | Purpose                                                    |
| --------- | ------------------- | --------- | ---------------------------------------------------------- |
| GET / PUT | `/config`           | 200       | Read / replace configuration.                              |
| GET       | `/credentials`      | 200       | List named credentials without their secrets.              |
| POST      | `/credentials`      | 201       | Create a named credential.                                 |
| PATCH     | `/credentials/:id`  | 200       | Rename, re-identify, or re-secret a credential.            |
| DELETE    | `/credentials/:id`  | 204 / 409 | Delete an unreferenced credential / refuse one in use.     |
| GET       | `/providers/kinds`  | 200       | List the provider kinds this host can configure.           |
| POST      | `/providers/models` | 200       | Read the model catalog a draft provider's endpoint serves. |
| GET       | `/tools`            | 200       | List the loaded tools and the settings each declares.      |
| GET       | `/resources`        | 200       | Read the resources of the machine the host runs on.        |

Projects and their workspace:

| Method | Path                          | Success   | Purpose                                            |
| ------ | ----------------------------- | --------- | -------------------------------------------------- |
| POST   | `/projects`                   | 202       | Reserve an environment without a Thread or prompt. |
| GET    | `/projects`                   | 200       | List Projects.                                     |
| GET    | `/projects/:id`               | 200       | Read public Project metadata.                      |
| PATCH  | `/projects/:id`               | 200       | Rename a Project.                                  |
| PATCH  | `/projects/:id/color`         | 200       | Set a palette color, or `null`.                    |
| POST   | `/projects/:id/threads`       | 201       | Create a root or child Thread.                     |
| GET    | `/projects/:id/threads`       | 200       | List Threads; optional `parentThreadId` filter.    |
| GET    | `/projects/:id/ssh`           | 200 / 202 | Read private SSH access / wait for environment.    |
| GET    | `/projects/:id/files`         | 200 / 202 | List one workspace directory.                      |
| GET    | `/projects/:id/tree`          | 200 / 202 | List a workspace directory as a tree.              |
| GET    | `/projects/:id/files/content` | 200 / 202 | Read one workspace file as bounded text.           |
| GET    | `/projects/:id/diff`          | 200 / 202 | Read the workspace Git diff and change list.       |
| GET    | `/projects/:id/changes`       | 200 / 202 | Read the changed paths with added/removed counts.  |
| GET    | `/projects/:id/files/diff`    | 200 / 202 | Compare one changed file (`repository`, `path`).   |
| GET    | `/projects/:id/resources`     | 200 / 202 | Read the Project sandbox's resources.              |
| GET    | `/projects/:id/terminals`     | 200       | List the Project's terminals.                      |
| POST   | `/projects/:id/terminate`     | 200       | Terminate the Project and its Threads.             |
| DELETE | `/projects/:id`               | 204       | Delete a terminal Project.                         |

Threads:

| Method      | Path                           | Success | Purpose                                                                             |
| ----------- | ------------------------------ | ------- | ----------------------------------------------------------------------------------- |
| GET         | `/threads/:id`                 | 200     | Read public Thread metadata.                                                        |
| PATCH       | `/threads/:id`                 | 200     | Rename a Thread, move its working directory, or set its provider, model and effort. |
| GET         | `/threads/:id/git`             | 200     | Read the Git summary of the Thread's directory.                                     |
| GET / POST  | `/threads/:id/branches`        | 200     | List local branches / switch to one (`branch`, `cwd`).                              |
| POST        | `/threads/:id/prompt`          | 202     | Enqueue human input; returns `promptId`.                                            |
| POST        | `/threads/:id/steer`           | 202     | Steer the running prompt, or queue when it ended.                                   |
| POST        | `/threads/:id/resume`          | 202     | Take up a prompt no run has finished; returns Thread.                               |
| POST        | `/threads/:id/rewind`          | 202     | Replace an earlier prompt and discard later turns.                                  |
| POST        | `/threads/:id/compact`         | 200     | Compact the idle Thread's context on demand.                                        |
| GET         | `/threads/:id/events`          | 200     | Replay durable events.                                                              |
| GET         | `/threads/:id/usage`           | 200     | Read the Thread's usage.                                                            |
| GET         | `/threads/:id/queue`           | 200     | Read the revisioned queue snapshot.                                                 |
| POST        | `/threads/:id/queue/resume`    | 200     | Reopen a stopped queue; returns Thread.                                             |
| GET / PATCH | `/threads/:id/queue/:promptId` | 200     | Read / edit a queued prompt that has not started.                                   |
| DELETE      | `/threads/:id/queue/:promptId` | 204     | Remove a pending input.                                                             |
| POST        | `/threads/:id/interrupt`       | 200     | Stop the Thread's active prompt.                                                    |
| POST        | `/threads/:id/terminals`       | 201     | Open a terminal in the Thread's sandbox.                                            |
| POST        | `/threads/:id/terminate`       | 200     | Terminate a Thread subtree.                                                         |
| DELETE      | `/threads/:id`                 | 204     | Delete a terminal subtree.                                                          |

Terminals and VMs:

| Method | Path                    | Success | Purpose                                          |
| ------ | ----------------------- | ------- | ------------------------------------------------ |
| GET    | `/terminals/:id`        | 200     | Read a terminal snapshot after an output cursor. |
| POST   | `/terminals/:id/input`  | 204     | Write input (`data`, up to 65536 characters).    |
| POST   | `/terminals/:id/resize` | 204     | Resize (`cols`, `rows`, 1–1000).                 |
| DELETE | `/terminals/:id`        | 204     | Stop a terminal.                                 |
| GET    | `/vms`                  | 200     | List provisioned VM runtimes.                    |
| GET    | `/vms/:id/ssh`          | 200     | Read the SSH access of one VM.                   |

Terminal routes answer `Cache-Control: no-store`; terminal data is never stored
in conversation events.

### Conventions

- Lists use `{ items, nextCursor? }`, with `limit` (1–100, default 50) and an
  exclusive UUID `cursor`. Page size does not limit total Projects or Threads.
- Public metadata omits message history, prompts, credentials, and SSH keys.
- Errors use `{ error: { code, message } }`. Invalid IDs and cursors return
  400, invalid bodies 422, missing resources 404, and lifecycle conflicts 409.
- Names are trimmed, reject NUL, and contain 1–80 Unicode characters.
- An answer may gain optional fields in any release. A client ignores the
  fields it does not know. A field is not removed or renamed, and does not
  change its type or meaning, without a notice in the release notes of an
  earlier release.

### Configuration and providers

`GET /config` answers `{ configuration, revision, updatedAt }`.

- The stored configuration holds no secret: a provider names the `API_TOKEN`
  credential it authenticates with, and `gitCredentialId` /
  `githubCredentialId` name the `GIT` identity and the `API_TOKEN` GitHub
  uses.
- `PUT /config` replaces the whole configuration and accepts that same shape,
  so what it answers is what it accepts. Unknown keys stay rejected
  (`422 invalid_config`), and a reference that names an unstored credential or
  the wrong kind is rejected with the same code. A replacement that cannot be
  activated answers `503 configuration_rejected`.
- Configuration saved here reaches the next prompt of any Project, including
  one that is already running.

`GET /providers/kinds` answers `{ kinds }`, the provider kinds a configuration
may name. Each kind has an `id`, a `label`, a `description`, its `fields` and
its `lists`, and may carry the optional `modelsFromCatalog` and `site`:

- each field has a `key`, a `label`, a `kind`, `required`, and the optional
  `description`, `placeholder`, `options` and `advanced`;
- `site` is `{ url, label }`: the page a client may link to, with the link's
  label. It is absent when the kind has none.

A client ignores the fields it does not know, as the conventions above say.

A provider kind whose catalog describes its models declares a models URL, and
that catalog is read twice:

1. When a provider page asks what its endpoint serves: `POST /providers/models`
   takes the draft's `kind` and `configuration` values and answers `{ models }`,
   every model with its name, its reasoning efforts, the effort it names as
   that model's default, whether it pins reasoning on, and the request
   parameters it advertises. Invalid values answer `422 invalid_provider`; an
   unreadable catalog answers `502 model_catalog_unreadable`.
2. On `PUT /config`: each listed model takes the reasoning that catalog
   describes, a model the catalog does not name takes none, and the execution
   effort resolves to the one its model starts at or is dropped when that
   model lists none. A catalog that cannot be read leaves that provider as it
   was, so an unreachable endpoint never costs the configuration its model
   list.

### Credentials

`/credentials` owns the credential store.

- `GET /credentials` answers
  `[{ id, kind, name, username?, email?, hasSecret }]` and never a secret.
- `POST` takes a `name` and a `kind` of `API_TOKEN` (`secret`),
  `USERNAME_PASSWORD` (`username` and `secret`), or `GIT` (`username` and
  `email`), and rejects a field the kind does not carry.
- `PATCH` follows one rule per field: absent or `null` keeps it, `''` clears
  it, and a value sets it. `kind` is immutable
  (`409 credential_kind_immutable`), and a name already used by the kind is
  `409`.
- `DELETE` of a credential a provider or the configuration references is
  `409 credential_referenced`.
- Secrets are stored as AES-256-GCM envelopes under `DORIC_CREDENTIAL_KEY`;
  the host refuses to start when a stored secret exists and that key is
  missing or unusable.

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

- **Project creation** requires `{ "name": "..." }` and answers `202` with the
  Project, which the host marks with a random color from its palette, plus an
  `ssh.href` pointing at `/projects/:id/ssh`.
- **Thread creation** requires `{ "name": "..." }` and accepts an optional
  `parentThreadId`, which starts the child in its parent's working directory.
  A top-level Thread copies the workspace default execution and a child its
  parent's; creation fails, creating nothing, when the configuration cannot be
  read.
- **Project PATCH** requires the name-only body; **Thread PATCH** takes
  `name`, `cwd`, an execution (`providerId` and `model`, optional `effort`),
  or any combination.
- **Thread execution.** `providerId` and `model` come together, and `effort`
  only with them; any other pairing answers `422 { code: 'invalid_thread' }`
  with `A Thread name, a working directory, an execution (providerId and
model, with an optional effort), or a combination is required.` The runtime
  checks the execution as a spawn's (`runtime.threads/v1.setThreadExecution`):
  the configured provider and its listed models, then `models/v1.resolve`. A
  refused execution answers `422 { code: 'invalid_execution' }` with
  `The provider is not configured.`, `The model is not available on this
provider.` or `This model does not support that effort.`; an unresolvable
  one carries `models/v1`'s message; a missing Thread answers `404`. The name
  and `cwd` are applied before the execution and kept when it is refused. A
  valid one answers the updated Thread, whose record carries `providerId`,
  `model` and `effort`, and applies from the Thread's next run.
- **Thread archive.** Thread records may carry `archivedAt` and `pinned`, set
  from the desktop app only (`runtime.threads/v1` 1.8.0; no route sets them).
  `DELETE /threads/:id` deletes an archived agent thread; a non-archived one is
  still refused.
- **Prompt** accepts only a non-empty `prompt`. Public callers cannot forge
  parent/result origins or correlation.
- **Rewind** accepts only `{ "promptId", "prompt" }` and answers
  `202 { promptId }` like a prompt. It removes the named turn and every later
  turn from the durable event log and the provider-ready history, then accepts
  the edited text as a new human input. Each turn records the provider-history
  length it started from, so rewind truncates exactly at that turn boundary. A
  Thread that is running or has queued input refuses with `409 thread_busy`, so
  queued work never runs on truncated history; a `promptId` without a recorded
  turn in that Thread returns `404 prompt_not_found`. Sequence numbers are
  never reused.
- **Interrupt** requires `{ "promptId" }` and answers
  `200 { status: 'interrupted' }`; the stop applies to whatever prompt the
  Thread is running. A Thread that is closing, terminal, or has no runtime is
  `409 thread_inactive`.
- **Resume** accepts only `{ "promptId" }` and answers `202` with the Thread.
  It re-enqueues that one prompt — bringing the Project's sandbox back when
  the host holds none — and appends the next `prompt.resumed` attempt. A
  prompt the Thread has not left unfinished is `404 prompt_not_found`, one it
  already holds running or queued is `409 thread_busy`, a Project that cannot
  run is `409 thread_inactive`, and low storage is `409 thread_storage_low`.
- **Compact** answers `{ status, condensedMessages, retainedMessages,
tokensFreed }`. A running or queued Thread is `409 thread_busy`, a refusal
  (disabled, no history, nothing to condense) is `409 compaction_refused`, and
  a failed attempt is `502 compaction_failed`.
- **SSH**: `GET /projects/:id/ssh` returns `202` with `Retry-After: 1` while
  pending, `409` when unavailable, and `410` when expired. SSH responses forbid
  caches.

### Workspace reads

`GET /projects/:id/files`, `/tree`, `/files/content`, `/diff`, `/changes`,
`/files/diff` and `/resources` share the lease answers: `202` with
`Retry-After: 1` while the environment is pending, `409` when unavailable, and
`410` when expired.

- A workspace-relative `path` is normalised, resolved against the workspace
  root, and rejected with `422` when it escapes; a missing path is `404`.
- Content is capped at 256 KiB (`CONTENT_LIMIT_BYTES`) and reported with
  `truncated` and `binary` flags, so a binary file is never rendered as
  mangled text.
- `/diff` answers one entry per repository with its `diff` and `changes`. A Git
  diff never contains untracked files, so the `changes` list supplies them
  alongside `diff`.
- A `path` on `/diff` also scopes discovery: the repositories it reads are the
  ones that path belongs to or holds, which is how one Thread reads the
  changes of its own working directory.

### The Thread working directory

Every Thread owns a working directory inside its Project's shared sandbox. It
starts at `/workspace`, and the agent moves it with its `cwd` tool, which calls
the same rule the HTTP route does.

- `PATCH /threads/:id` takes an optional `cwd`: an absolute sandbox path, or
  one relative to the Thread's current directory the way `cd` reads it.
- A move that would leave the workspace root answers
  `400 { code: 'invalid_cwd' }`, and so does one that names no directory or
  names a file; a valid move answers the updated Thread.
- The Thread record carries the directory as `cwd` plus a cheap hint as
  `cwdRepo`: absent unless the directory's own root holds a `.git` marker, then
  `github` when that repository's `origin` points at github.com and `git`
  otherwise.
- The hint is an observation, refreshed whenever the directory moves, when one
  of the Thread's prompts settles, and when the Git summary below is read —
  and `thread:updated` is published only when it really changed.

When a Project reacquires a sandbox, every Thread whose directory is not the
workspace root is checked in one probe: a directory the sandbox no longer holds
— missing, no longer a directory, or resolving outside the root — is reset to
`/workspace` with its hint cleared, and one `thread:updated` is published for
each reset. Only an explicit negative answer resets a directory: a probe that
cannot run keeps every stored directory, because a command that failed is not
evidence that the directories are gone.

`GET /threads/:id/git` answers the Git summary of the Thread's working
directory:

- `{ repo: false }` when the directory holds, or lies in, no repository;
- otherwise its `root`, `head` (the branch, or the short commit when HEAD is
  detached), `detached`, `unborn`, `upstream`, `ahead`, `behind`, `dirty`
  (`staged`/`modified`/`untracked`), `conflicted`, `operation`
  (`merge`/`rebase`/`cherry-pick`/`revert`/`bisect`), `worktree`, `shallow`,
  and `stash` count.

One sandbox command per probe reads all of it — a
`git status --porcelain=v2 --branch` document whose headers already carry the
branch, its upstream, and the ahead/behind counts, plus the labeled facts a
small shell script prints around it — and the answer is cached per Thread until
the directory moves, a prompt settles, or the renderer asks for it. While the
Project's sandbox is not readable, the route (like `/branches`) still answers
`200` with `{ status: 'pending' }` or `{ status: 'unavailable' }`, so clients
can poll without treating it as an error; an unknown Thread is `404`.

### The prompt queue

- `GET /threads/:id/queue` returns a non-cached, revisioned snapshot with
  `paused`, `stopping`, the current active or resumable prompt, and the FIFO
  pending items, each with its prompt ID, source, display label, bounded
  preview and acceptance time.
- `POST /threads/:id/queue/resume` reopens a stopped queue: it resumes the
  latest eligible reader-paused prompt first and then the FIFO.
- `GET /threads/:id/queue/:promptId` returns the full text, edit eligibility
  and revision. `PATCH` on it requires `{ text, revision }`: only a user input
  that has never started can be edited, and a stale revision is `409`.
- `DELETE /threads/:id/queue/:promptId` removes a pending input and records
  `prompt.finished` with `status: cancelled` and `reason: queue_removed`; it
  refuses an input already executing.

### Replay

`GET /threads/:id/events?afterSequence=N` returns `{ events, lastSequence }`.
The optional cursor is exclusive (default 0). Sequence numbers are contiguous
per Thread, not globally ordered across Threads. Each event contains:

```text
{ projectId, threadId, promptId, sequence, type, event, createdAt }
```

Events are persisted before publication. Their bodies include model reasoning,
provider replay, tool inputs/results, usage, and failures. Credentials are
redacted before persistence, and the characters PostgreSQL refuses — U+0000 and
an unpaired surrogate, which binary tool output can carry — become U+FFFD, so a
single binary match cannot fail a Thread. Full prompt/event payloads are not
operational logs.

Rewind appends one `history.truncated` event whose body is
`{ type: 'history.truncated', afterSequence }`; `afterSequence` is the sequence
of the last surviving event, or `0` when none survives. Subscribers receive it
before the replacement `prompt.accepted`. Because sequence numbers are never
reused, later events continue above the marker and a replay cursor above it
simply skips the discarded range; clients drop their local events above
`afterSequence`.

### Command-line client

```sh
npm run doric:spawn-agent -- --url http://127.0.0.1:3000 \
  --prompt "Inspect the workspace" --terminate
```

The client creates a Project, then a Thread, submits the input, polls durable
replay, and prints only IDs, event metadata, and the Project SSH URL.
`--url` defaults to `DORIC_URL` or `http://127.0.0.1:3000`. Without
`--terminate`, the Project remains reserved; with it, the entire Project closes
after the submitted prompt ends, including any still-running descendants.
Configure `/config` and server credentials separately; the client does not
send credentials or A2A configuration.

## Socket.IO

```ts
import { Manager } from 'socket.io-client';

const manager = new Manager('http://127.0.0.1:3000');
const status = manager.socket('/status');
const project = manager.socket('/projects', { auth: { projectId } });

// Every watched Thread owns a Manager of its own, so that closing that
// connection is what ends the subscription the host holds for the Thread.
const thread = new Manager('http://127.0.0.1:3000').socket('/threads', {
  auth: { threadId, afterSequence: 42 },
});
```

| Namespace               | Event               | Payload                                                |
| ----------------------- | ------------------- | ------------------------------------------------------ |
| `/status`               | `connect`           | None; confirms that the Doric host is reachable.       |
| `/threads`              | `thread:snapshot`   | `{ threadId, projectId, project, thread, events }`     |
| `/threads`              | `agent:event`       | Complete persisted Thread event envelope.              |
| `/threads`, `/projects` | `thread:updated`    | Public Thread metadata.                                |
| `/threads`, `/projects` | `thread:deleted`    | `{ projectId, threadId }`                              |
| `/projects`             | `project:snapshot`  | `{ projectId, project, threads, terminals }`           |
| `/projects`             | `project:updated`   | Public Project metadata.                               |
| `/projects`             | `project:deleted`   | `{ projectId }`                                        |
| `/projects`             | `terminal:snapshot` | `{ projectId, terminals }`                             |
| `/projects`             | `terminal:updated`  | One terminal session.                                  |
| `/projects`             | `terminal:output`   | Live terminal output.                                  |
| `/projects`             | `terminal:removed`  | `{ projectId, threadId, terminalId }`                  |
| `/threads`, `/projects` | `workspace:error`   | Sanitized `{ code, message }`; connection then closes. |

The desktop app reaches the host through a separate generic namespace,
`/doric/bridge`, owned by the kernel.

### Subscriptions

- `/status` requires no parameters and emits no application payload.
- `/threads` requires `auth: { threadId, afterSequence? }` and `/projects`
  requires `auth: { projectId }`; an invalid handshake is refused.
- Reuse one `Manager` for `/status` and the Project subscription so they share
  one Engine.IO connection, and give each watched Thread a `Manager` of its
  own: closing that connection is what ends the Thread's subscription.
- Missing snapshot resources are `null`. The Project snapshot contains the full
  Thread tree as a flat array with `parentThreadId` links. Project
  reconnection resnapshots that tree; execution history is replayed separately
  per Thread.
- Thread subscriptions are installed before durable replay, buffer live events
  and lifecycle notifications, and deduplicate by sequence. Clients reconnect
  with their last received sequence.
- Terminal output is not buffered during a snapshot; a reconnect reads the
  bounded terminal snapshot instead.

### Prompt events

- Each accepted input emits `prompt.accepted` with `{ type, text, source }`;
  `text` is the input after configured-credential redaction and `source` is
  its trusted origin.
- The host emits `prompt.finished` with `{ type, status, text, source }`;
  `status` is `completed`, `failed`, or `cancelled`. Success is acknowledged
  only after conversation history is saved. Use this event, not the inner
  `agent.finished`. A persistence failure can instead make the Thread terminal
  with `persistence_failed`; clients must also observe Thread state.
- An interruption that leaves a prompt unfinished emits `prompt.paused` with
  `{ type, reason }`, where `reason` is `host_stopped` when the host stopped,
  `host_restarted` when a boot discovered the restart a run never recorded,
  and `reader_stopped` only in logs written before the reader's stop ended the
  turn.
- The reader's stop (`POST /threads/:id/interrupt`) finishes the prompt with
  `prompt.finished` `status: cancelled` and `reason: interrupted`, keeping its
  history. A prompt that never started is left without one: it was never
  running.
- The host takes its own interruptions up again by appending
  `prompt.resumed` with `{ type, attempt }`, counting from `1`, and a reader's
  own resume of the same prompt does the same under the prompt's own
  `promptId`. A resumable prompt is unfinished: a client that sees one — no
  `prompt.finished`, and a pause or a `prompt.resumed` as its last word — can
  offer the reader `POST /threads/:id/resume`.

### Steering and delivered results

`POST /threads/:id/steer` takes `{ prompt, promptId, interrupt? }`, where
`promptId` is the prompt the reader saw running, and answers
`{ status, promptId }`:

- `steered` means the running prompt takes the input in at its next safe point
  — after the tool batch in flight, or before its final answer — and
  `interrupt: true` also aborts its current step so it continues with the
  steer at once.
- `queued` means the prompt was no longer running, or the Thread was stopping,
  so the input was queued as an ordinary prompt.

The steer is accepted as `prompt.accepted` with `steer` naming the running
prompt; taking it in appends `prompt.steered` under the steer's own id, and a
steer the run ended without reading returns to the front of the queue with
`prompt.queued` `first: true`.

Delegated results and background terminal results are delivered automatically.
A Thread that is running takes them in as steers of its active prompt at the
next safe point, without interrupting it; otherwise they are queued. They can
trigger additional model/tool activity.

## Docker deployment details

The image builds the bundles through the same Nx target as a local build,
`NX_DAEMON=false npx nx run doric-host:build-bundles --skip-nx-cache`: it
builds every Nx project tagged `type:bundle`, then `stage --all` stages every
directory `bundles/<group>/<id>` that holds a `manifest.json` into
`app/backend/doric-host/dist/bundles`. A bundle needs both: a manifest with no
tag is not built, and `stage` then fails on its missing `dist/manifest.json`,
which fails the image build. Dependencies are installed with
`npm ci --ignore-scripts`, so no lifecycle script runs; the image runs Nx's
`post-install` step itself. The build starts no Nx daemon and reads no Nx
cache.

### The sandbox image

The Docker profile runs sandboxes from the image built from
[`.sandbox.Dockerfile`](.sandbox.Dockerfile). On top of the base image's Git it
adds:

- the GitHub CLI;
- Docker's engine and CLI;
- the runtime libraries Electron needs, with Xvfb for headless runs, and the
  xpra screen server with its HTML5 client;
- esbuild under `/opt/doric/bundler`, so component previews bundle inside the
  sandbox (on the plain image they bundle on the host, reading each file
  through it).

Compose selects it through `DORIC_SANDBOX_IMAGE` (`doric-sandbox:local` by
default); without that variable the host provisions the plain
`node:22-bookworm` image. Build the tag before `up`:

```sh
# from the repository root, before `docker compose --profile docker up`
docker build -f app/backend/doric-host/.sandbox.Dockerfile -t doric-sandbox:local app/backend/doric-host
```

Build it first: the provider pulls an image only when it is absent locally, so
a tag that was never built fails the pool's image pull instead of silently
falling back to the plain Node image. The `firecracker` profile resolves an
anonymous **public** OCI image rather than a local tag, so it can only use this
image once the tag is published or `DORIC_SANDBOX_IMAGE` is pointed at a public
image.

The sandbox's Docker CLI reaches a daemon only where the sandbox is given
`/var/run/docker.sock` or the privileges `dockerd` needs, as Compose does for
the host itself. Set `DORIC_SANDBOX_DOCKER_SOCKET=true` in the environment file
to mount that socket into every Project sandbox. Compose leaves it off unless
the environment file sets it, because a sandbox holding the socket can drive
the host's Docker daemon; `.env.example` turns it on for local development.
Keep it off where Projects are not yours.

### Build traps

Two traps break the image build or the deployed catalog:

- Every bundle must be an Nx project tagged `type:bundle` and live in
  `bundles/<group>/<id>` with a `manifest.json`. `build-bundles` builds the
  tagged projects; `stage --all` stages the manifest directories. A manifest
  whose project has no tag is not built, so `stage` fails on its missing
  `dist/manifest.json` and the image build fails (the `.dockerignore` excludes
  `**/dist`, so no local build hides it). A tagged project outside
  `bundles/<group>/<id>` is built but never staged, and nothing reports it: the
  bundle is absent at runtime and its composition entry is reported missing.
- `package-lock.json` must be generated with the npm major the build image runs
  (`node:22-bookworm-slim` ships npm 10). A lock rewritten by a newer local npm
  fails `npm ci` with `Missing: <package> from lock file`; regenerate it with
  `npx npm@10 install --package-lock-only`.

### Rotating the PostgreSQL password

To replace the PostgreSQL password of an existing deployment without losing
data, alter the role through the container's trusted local socket instead of
recreating the volume. The Compose project is named `doric-sandbox` (or `doric`
when started with `npm run doric:docker:build`), and the role is your
`DORIC_POSTGRES_USER`:

```sh
docker exec -it doric-sandbox-postgres-1 \
  psql -U doric -h 127.0.0.1 -d doric -c "ALTER ROLE doric WITH PASSWORD 'NEW'"
```

## Provider upgrades

The catalog advertises **OpenAI** (Responses-compatible endpoints) and
**OpenRouter** (the former Unified implementation). Codex remains internal and
is not advertised. LM Studio integrations and the raw OpenRouter adapter have
been removed.

- The consolidation migration maps `unified` to `openrouter` and
  `openai-compatible` to `openai`, preserving provider ids, credential
  references, models and execution selections.
- Compatible providers pointing at the standard OpenRouter URL, including the
  bootstrap row, become `openrouter`.
- Historical Project snapshots and events are preserved; usage reads still
  recognize old `unified` events.

Before upgrading a database with `lmstudio` or `lmstudio-openai` providers, use
the previous app version to configure a supported replacement, select it for
execution, and remove the old entries. The migration refuses those removed
protocols instead of silently changing endpoints or deleting configuration.

## Persistence and security

### Database

PostgreSQL holds everything durable: Projects, Threads, provider histories and
Thread event streams (kept in the generic `storage_*` tables of
`storage.backend/v1`), the configuration's `settings/v1` document, and the
credential table.

- The schema and migrations live in the `postgres` bundle
  (`bundles/foundation/postgres/prisma`);
  `app/backend/doric-host/prisma.config.ts` points at them.
- Apply migrations separately with `npx nx run doric-host:migrate` (Compose
  runs its `migrate` service); startup does not apply them.
- The history starts with the clean Project/Thread baseline, bootstrap
  configuration, singleton constraint, and immutable-tree trigger. Later
  migrations add, among others, Project and Thread names, per-turn provider-history
  checkpoints that rewind truncates, Project colors, the credential store,
  provider kinds and models, Thread working directories, usage and queue
  pauses, the provider consolidation, generic storage, runtime documents,
  registered credential kinds, the coalescing of stored Thread deltas and the
  drop of the legacy Project and Thread tables. They do not convert Session
  data.
- The generic-storage migration converts the configuration tables into the
  `host-config.configuration/v1` settings document, keeping its revision and
  update time, verifies the conversion, and then drops those tables. It
  cannot be reversed, so **back up the database first**.
- The delta-coalescing migration (`20261021000000_coalesce_thread_deltas`)
  rewrites the stored Thread event streams so each streamed response keeps
  one entry per run of deltas instead of one per token. It cannot be
  reversed and must run offline; follow
  [Coalescing stored Thread deltas](#coalescing-stored-thread-deltas).
- The drop migration (`20261117000000_drop_legacy_runtime_tables`) drops the
  legacy `project`, `thread` and `thread_event` tables, which are empty since
  the runtime-documents migration moved their rows. It refuses while any of
  them still holds a row and cannot be reversed; follow
  [Legacy rows at the drop migration](#legacy-rows-at-the-drop-migration).

Start from an empty database. A database with an older (pre-baseline) schema
or migration history must be explicitly recreated by its operator before
deployment. Neither the host nor the baseline deletes or resets an existing
database automatically.

### Coalescing stored Thread deltas

`20261021000000_coalesce_thread_deltas` folds each run of consecutive
`reasoning.delta`, `text.delta`, `refusal.delta` or `tool_call.delta` entries of
a Thread's event stream into the run's first entry, which keeps its sequence
and carries the whole delta, and drops deltas that say nothing. Conversations read the
same; sequence numbers are never renumbered, so the removed entries leave
gaps, and each stream still ends at its counter. On a database whose long
Threads streamed token by token this removes most of the event rows (a
646,307-entry database keeps 30,228).

The migration verifies its result in the same transaction and aborts, changing
nothing, on any mismatch. When it changes anything it increments the storage
generation, so every desktop discards its local history snapshots and replays
each conversation from the host. It records the `coalesced-thread-deltas` row
of `storage_meta`, so applying it again does nothing. **It cannot be
reversed**: the only rollback is restoring the backup taken in step 3.

The examples use the Compose container `doric-postgres-1` and the role and
database `doric`; substitute your own (`doric-sandbox-postgres-1` for the
default Compose project name, your `DORIC_POSTGRES_USER` and
`DORIC_POSTGRES_DB`).

1. Quit the Doric desktop app on every machine that connects to this host.
2. Stop the host (`Ctrl+C` on `nx serve doric-host`, or
   `docker compose stop docker` / `firecracker`). Keep PostgreSQL running.
   With Compose, do not run `up` with the new image before step 3: its
   `migrate` service applies pending migrations.
3. Back up the database:

   ```sh
   docker exec doric-postgres-1 pg_dump -U doric -d doric -Fc > doric-before-coalesce.dump
   ```

4. Apply the migration, natively with `DORIC_DATABASE_URL` pointing at the
   database (`npx nx run doric-host:migrate`), or with Compose
   (`docker compose run --rm --build migrate`). It holds its transaction for
   the whole rewrite, about 15 seconds for 650k entries.
5. Check the result; `storageGeneration` of `identity` is one higher than
   before, and the marker holds the entry counts:

   ```sh
   docker exec doric-postgres-1 psql -U doric -d doric -c \
     "SELECT key, value FROM storage_meta"
   ```

6. Still with the host stopped, return the freed space to the filesystem.
   `VACUUM FULL` locks the table while it rewrites it:

   ```sh
   docker exec doric-postgres-1 psql -U doric -d doric -c \
     "VACUUM (FULL, ANALYZE) storage_stream_entry"
   ```

7. Start the host, then the desktop. The snapshots of the previous generation
   stay in the history bundle's cache directory, unused.

To roll back, stop the host and restore the backup over the database, for
example `docker exec -i doric-postgres-1 pg_restore -U doric -d doric --clean --if-exists --single-transaction < doric-before-coalesce.dump`.
The restored database has not recorded the migration, so the next
`prisma migrate deploy` of this version applies it again.

### Legacy rows at the drop migration

`20261117000000_drop_legacy_runtime_tables` drops the legacy `project`,
`thread` and `thread_event` tables, with the `guard_thread_tree()` function and
the `ProjectState` and `ThreadState` enums only they use. The runtime-documents
migration (`20261010000000_runtime_documents`) moved their rows into the
runtime's storage documents and streams and deleted them, so on a database
that has run it the tables are empty. The drop migration locks the three
tables and counts their rows in one transaction; if any table holds a row, it
raises `Legacy table "<name>" holds <n> rows` and the transaction aborts, so
nothing is dropped. Tables that are already gone are skipped. **It cannot be
reversed**: the only way back is restoring the backup taken in step 3.

Until the tables are gone, the host's startup check reads them: when all three
exist and one of them holds a row, the host fails at its `database_client` stage, whether or not the
runtime-documents migration has run, so the host never serves an empty history
over data it has not moved.

The examples use the same container, role and database as
[Coalescing stored Thread deltas](#coalescing-stored-thread-deltas).

1. Quit the Doric desktop app on every machine that connects to this host.
2. Stop the host (`Ctrl+C` on `nx serve doric-host`, or
   `docker compose stop docker` / `firecracker`). Keep PostgreSQL running.
   With Compose, do not run `up` with the new image before step 3: its
   `migrate` service applies pending migrations.
3. Back up the database:

   ```sh
   docker exec doric-postgres-1 pg_dump -U doric -d doric -Fc > doric-before-drop.dump
   ```

4. Apply the migration, natively with `DORIC_DATABASE_URL` pointing at the
   database (`npx nx run doric-host:migrate`), or with Compose
   (`docker compose run --rm --build migrate`).
5. If it raises, a row was written to a legacy table after the
   runtime-documents migration, and nothing was dropped. Either restore the
   backup, or export the rows and delete them, in this order:

   ```sh
   docker exec doric-postgres-1 pg_dump -U doric -d doric --data-only \
     -t thread_event -t thread -t project > doric-legacy-rows.sql
   docker exec doric-postgres-1 psql -U doric -d doric -c \
     'DELETE FROM thread_event; DELETE FROM thread; DELETE FROM project;'
   ```

   Then mark the failed migration as rolled back and deploy again:

   ```sh
   npx prisma migrate resolve --rolled-back 20261117000000_drop_legacy_runtime_tables --config app/backend/doric-host/prisma.config.ts
   npx nx run doric-host:migrate
   ```

6. Start the host, then the desktop.

Rolling the code back to a build whose `prisma/migrations` folder contains
`20261010000000_runtime_documents` starts on the migrated database: AC10.5
checked it with the build of `5a1da9b8` (see the phase 10 entry of
[the feature doc](../../../docs/features/bundle-isolation.md#evolution)). A
build without that folder could not serve this database before the drop either
(Spec 1, §16), so the backup does not help it. The owner confirms this limit
before the branch merges (OD-12).

### Network exposure

The API is unauthenticated. Keep it on an isolated trusted network, especially
because SSH responses and execution replay contain sensitive material. Provider
credential values belong in the credential store, never configuration JSON or
client requests.

### Credentials

The host owns one credential store for every secret it holds. Each credential
is named and has a kind that fixes its fields:

| Kind                | Fields                          | Use                                                |
| ------------------- | ------------------------------- | -------------------------------------------------- |
| `API_TOKEN`         | `secret`                        | Authentication: a provider key, the GitHub token.  |
| `USERNAME_PASSWORD` | `username`, `secret`            | Authentication with a name.                        |
| `GIT`               | `username`, `email` (no secret) | The identity the agent's git commands commit with. |

A secret is stored as an AES-256-GCM envelope under `DORIC_CREDENTIAL_KEY` and
is never answered over the API; the host redacts every stored secret from
events and logs before persistence and keeps it out of tool payloads. The
credential store was created by migration from the former provider environment
names and the former GitHub columns, so every provider keeps its row with a
credential whose secret is empty until its operator fills it, and the former
plaintext GitHub token is re-entered once.

### Git and GitHub inside the sandbox

The host applies the Git identity and the GitHub token to a Project's sandbox:

- `git config --global` for the identity;
- when a token is configured, `credential.helper store` plus a
  `~/.git-credentials` written 0600, and a `~/.config/gh/hosts.yml` written
  0600 so the token authenticates the sandbox's `gh`.

That happens when a lease is acquired and again whenever the current pair
differs from the one the sandbox holds, because the chosen credentials follow
the current configuration while every other value stays captured per Project.
The token travels only through the sandbox process environment, so it never
appears in a tool argument, a tool result, an event, or a log line; a write
that fails is a warning naming the Project and nothing else.

## Storage protection

The host checks available filesystem blocks at `DORIC_STORAGE_PATH` before
dispatch and every three seconds during execution.

- At **10% free or less**, or when the configured path cannot be measured,
  execution pauses and the queue shows an error.
- Free space above 10%, then resume the queue
  (`POST /threads/:id/queue/resume`); recovery never starts automatically.
- PostgreSQL disk-full errors are handled as the same pause, independently of
  the probe.

Compose sets `DORIC_STORAGE_PATH=/var/lib/doric/postgresql` and mounts its
PostgreSQL volume there read-only. Native runs default to the current
directory; set this variable to a path on the actual database filesystem. A
local path does not measure a remote PostgreSQL server: remote deployments
require a mount on that filesystem for proactive protection.

If the disk is already completely full, the host retains any unsaved history
and event in memory and refuses to resume until it can save them. Keep that
host process alive while freeing space; a process crash cannot preserve unsaved
data.

## Validation

| Command                                          | What it covers                    |
| ------------------------------------------------ | --------------------------------- |
| `npx nx run doric-host:test`                     | The host suite.                   |
| `npx nx run doric-host-e2e:e2e`                  | The full host workflow.           |
| `npx nx run agent:test`                          | The reusable agent loop.          |
| `node --test scripts/tests/spawn-agent.test.mjs` | The command-line client workflow. |

The host targets build the bundled tools first.

To include persistence tests, supply `DORIC_TEST_DATABASE_URL` pointing to a
dedicated PostgreSQL test instance. The e2e target also requires
`DORIC_TEST_SANDBOX=true`; it creates a disposable database and Docker sandbox,
and scripts only the external LLM. Without these variables, persistence cases
in `doric-host:test` skip and `doric-host-e2e:e2e` fails before running.
