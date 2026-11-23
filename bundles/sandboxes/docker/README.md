# Docker bundle

`docker` gives every Doric Project its own Docker container to work in, so the
agent can install packages, run servers and change files without touching your
machine. Each Project keeps a durable workspace volume, so its files survive
the container, a host restart and the next lease of the Project's sandbox.

It is a sandbox bundle with one part, a host part, that provides `sandbox/v1`
over the Docker Engine API. It is the default sandbox provider of the shipped
host; the alternative is [`firecracker`](../firecracker/README.md). The
[main README](../../../README.md) describes Doric as a whole, and
[`packages/bundle`](../../../packages/bundle/README.md) how a bundle is built,
loaded and activated. The flow across bundles that leases a Project's sandbox
is described in the feature doc
[Projects and Threads](../../../docs/features/projects-and-threads.md#leases-and-the-sandbox-pool).
The feature doc [Sandboxes](../../../docs/features/sandboxes.md) describes
both sandbox providers and how one is chosen. This README is the bundle's
complete description.

## Manifest

[`manifest.json`](manifest.json):

| Field             | Value                                                                                     |
| ----------------- | ----------------------------------------------------------------------------------------- |
| `manifestVersion` | `1`                                                                                       |
| `id`              | `docker`, version `1.0.0`, engine `doric ^1.0.0`                                          |
| `description`     | "Docker sandbox provider for the Doric agent: one durable-workspace sandbox per Project." |
| `provides`        | `sandbox/v1@1.0.0`                                                                        |
| `requires`        | `hooks/v1@^1.0.0`, `log/v1@^1.0.0`                                                        |

The bundle has no `optional` contracts, slots, settings, tools, routes,
elements, storage types or `desktopScope`. Its package
([`package.json`](package.json)) is `docker`, private, and exports only
`./package.json`: the bundle has no contracts module of its own, because

- **Host process** ([`src/host/main.ts`](src/host/main.ts), built into
  `dist/host/main.mjs`): runs the host part as a process with `runBundle`,
  serving `SandboxService` by lease id through the router
  ([`src/host/service.ts`](src/host/service.ts)). A lease belongs to the
  calling instance: an unknown, released or other instance's lease fails with
  `unknown_lease` (`NOT_FOUND`), and an operation the sandbox does not offer,
  such as `Start` on a sandbox without live processes, with
  `unsupported_operation` (`UNIMPLEMENTED`). When an instance is gone
  (`context.instances.onGone`) its leases are released; `deactivate` releases
  every lease and disposes the pool. The running host keeps the kernel entry
  `src/host/index.ts` until the switch (phase 3, slice S44 of
  [`grpc-processes.md`](../../../docs/designs/grpc-processes.md)).

`sandbox/v1` is declared by the [`runtime`](../../runtime/runtime/README.md)
bundle in `runtime/contracts`.

## Parts

- **Host** ([`src/host/index.ts`](src/host/index.ts)): exports `activate`,
  built by `activateDockerSandbox()` in
  [`src/host/sandbox.ts`](src/host/sandbox.ts). On activation it reads the
  settings from the environment, builds the Docker client, the registry of
  running machines and the sandbox pool, provides `sandbox/v1` over them,
  and registers its start step ([`src/host/start.ts`](src/host/start.ts)).
  Activation contacts no daemon: Docker is first called by the first
  `acquire` or `discard`. Its cleanup disposes the start step's registration and then the
  pool.

`activateDockerSandbox(options)` takes two optional options, which the tests
use ([`src/host/sandbox.ts`](src/host/sandbox.ts)):

| Option        | Type                                                   | Default              |
| ------------- | ------------------------------------------------------ | -------------------- |
| `environment` | `Readonly<Record<string, string \| undefined>>`        | `process.env`        |
| `client`      | `(options: CreateDockerClientOptions) => DockerClient` | `createDockerClient` |

The shipped composition does not list `docker` under `resident`, so its host
part runs in the generation process, next to `runtime`, and reads the
environment that process inherits from the kernel
([`composition.json`](../../../app/backend/doric-host/composition.json),
[`resident`](../../../docs/architecture/bundles/composition-and-distribution.md#resident)).

## Contract provided

### `sandbox/v1` (host, 1.0.0)

Declared in `runtime/contracts`
([`sandbox.ts`](../../runtime/runtime/src/contracts/sandbox.ts)) and provided
by [`src/host/sandbox.ts`](src/host/sandbox.ts), with cardinality `one`, the
default of `defineService`
([Contracts](../../../docs/architecture/bundles/contracts.md)). `CallArg` is
the optional call argument of `bundle/contracts`, described in
[The call](../../../docs/architecture/bundles/contexts.md#the-call):

```ts
interface SandboxProviderApi {
  describe(call?: CallArg): Promise<SandboxDescription>;
  acquire(
    input: { identity: string; signal?: AbortSignal }, // strict object
    call?: CallArg,
  ): Promise<SandboxLease>;
  discard(identity: string, call?: CallArg): Promise<void>;
  machines(call?: CallArg): Promise<readonly RunningMachine[]>;
  machine(id: string, call?: CallArg): Promise<RunningMachine | undefined>;
}

// loose objects: other fields pass through
type SandboxDescription = { provider: string; durableWorkspace: boolean };
type RunningMachine = { id: string; provider: string };

// from sandpool; process-local
interface SandboxLease {
  readonly sandbox: Sandbox; // the `sandbox` package's session
  readonly release: () => Promise<void>;
}
```

| Method     | Input                   | Output                        | What `docker` answers                                                                                                                                              |
| ---------- | ----------------------- | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `describe` | none                    | `SandboxDescription`          | `{ provider: 'docker', durableWorkspace: true }`                                                                                                                   |
| `acquire`  | `{ identity, signal? }` | `SandboxLease` (local object) | A new pool sandbox for `identity`, sharing the workspace's container when this process already serves it                                                           |
| `discard`  | `identity`              | `void`                        | Removes the workspace's containers, then its volume                                                                                                                |
| `machines` | none                    | `RunningMachine[]`            | One entry per container id whose disposal has not completed (a failed disposal stays listed), `provider: 'docker'` (see [Durable workspaces](#durable-workspaces)) |
| `machine`  | machine id              | `RunningMachine \| undefined` | That entry while it is listed, else undefined                                                                                                                      |

Only `acquire` is process-local: its lease and its `signal` are live objects,
so only a bundle in the same process can call it. `describe`, `discard`,
`machines` and `machine` take and return plain data, so the kernel reaches
them across processes ([`sandbox.ts`](../../runtime/runtime/src/contracts/sandbox.ts)).
The platform validates each call with the method schemas of `sandboxMethods`,
rejecting an input that fails them with `invalid_input` and a result that
fails them with `invalid_output`, as
[Contracts](../../../docs/architecture/bundles/contracts.md) describes. No
method has an error code of its own: a failure reaches an in-process caller as
the error thrown, and a caller in another process as a `ContractError` of
code `internal` with the same message
([`error.ts`](../../../packages/bundle/src/contracts/error.ts)). The failures
are listed under [Errors and failure behavior](#errors-and-failure-behavior).

`runtime` acquires with the Project id as `identity` and discards that identity
when the Project is deleted
([runtime README](../../runtime/runtime/README.md#sandboxv1)); `transport`
answers `GET /vms` with `machines` and `machine`
([transport README](../../foundation/transport/README.md)).

## Contracts used

| Contract             | Kind     | What for                                                                                                                                                                                   |
| -------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `hooks/v1`           | requires | Registers the start step on `doric.app.hooks/v1.onHostStartHook` ([`src/host/start.ts`](src/host/start.ts))                                                                                |
| `log/v1`             | requires | Receives the pool's log records ([`src/host/logger.ts`](src/host/logger.ts))                                                                                                               |
| `doric.app.hooks/v1` | platform | `onHostStartHook`, a `sequence` hook the host runs once before it listens ([Hooks](../../../docs/architecture/bundles/hooks.md#host-start-and-stop))                                       |
| `doric.startup/v1`   | platform | `stage(name)` and `log({ level, fields, message })` of the start step ([`src/host/start.ts`](src/host/start.ts), [Hooks](../../../docs/architecture/bundles/hooks.md#host-start-and-stop)) |

The host part builds on three workspace packages: the Docker client and the
workspace volumes of [`docker-sandbox`](../../../packages/docker-sandbox/README.md),
the sandbox sessions and the machine registry of
[`sandbox`](../../../packages/sandbox/README.md), and the pool of
[`sandpool`](../../../packages/sandpool/README.md).

## Configuration

The host part reads these variables at activation
([`src/host/sandbox.ts`](src/host/sandbox.ts)):

| Variable                      | Default            | Meaning                                                      |
| ----------------------------- | ------------------ | ------------------------------------------------------------ |
| `DORIC_SANDBOX_IMAGE`         | `node:22-bookworm` | The image each sandbox runs                                  |
| `DORIC_SANDBOX_SSH`           | off                | Exactly `true` enables SSH into each sandbox                 |
| `DORIC_SANDBOX_DOCKER_SOCKET` | off                | Exactly `true` mounts the daemon's Unix socket into each one |
| `DORIC_SANDBOX_CPUS`          | `4`                | The CPUs each sandbox may use                                |
| `DORIC_SANDBOX_MEMORY_MIB`    | `2048`             | The memory each sandbox may use, in MiB                      |

- `DORIC_SANDBOX_IMAGE` is used as written: an image tag that is neither
  present nor pullable fails the acquisition, and nothing falls back to the
  default. An empty value is used as the image too, unlike the CPU and memory
  settings.
- `DORIC_SANDBOX_SSH` and `DORIC_SANDBOX_DOCKER_SOCKET` are on only for the
  exact value `true`; any other value is off.
- `DORIC_SANDBOX_CPUS` and `DORIC_SANDBOX_MEMORY_MIB` take a whole positive
  number (`/^[1-9]\d*$/`). An unset or empty value keeps the default; any other
  value throws `<NAME> must be a whole positive number, got "<value>"`, which
  fails activation.
- The CPU and memory settings are ceilings the daemon enforces, not
  reservations, so an idle sandbox holds neither.
- Sharing the daemon socket lets code in a sandbox build and run the images its
  Project describes, and gives that sandbox the daemon's authority on the host
  ([`docker-sandbox`](../../../packages/docker-sandbox/README.md#sharing-the-docker-socket)).
  On a named-pipe connection (Windows) there is no socket to share, and the
  setting has no effect, although the start step still logs
  `dockerSocketShared: true`
  ([`docker.ts`](../../../packages/docker-sandbox/src/lib/docker.ts)).

The Docker client is created with only `exposeDockerSocket` set, so it uses
the defaults of [`docker-sandbox`](../../../packages/docker-sandbox/README.md#options):
the daemon at `/var/run/docker.sock` (or `DOCKER_HOST=unix://…`) on Unix and
Docker's named pipe on Windows, the Dropbear binary for SSH at
`/opt/doric/firecracker/dropbearmulti`, and the state directory
`/var/lib/doric/docker`.

The shipped composition enables this bundle or `firecracker` through the
alternative `sandbox`, chosen by `DORIC_SANDBOX_PROVIDER`: `docker` unless the
variable is `firecracker`
([`composition.json`](../../../app/backend/doric-host/composition.json),
[`alternatives`](../../../docs/architecture/bundles/composition-and-distribution.md#alternatives)).
The bundle itself does not read `DORIC_SANDBOX_PROVIDER`.

## How it works

### Activation

From the settings, the host part builds
([`src/host/sandbox.ts`](src/host/sandbox.ts)):

1. the Docker client, `createDockerClient({ exposeDockerSocket })`;
2. the machine registry, `createVmRegistry('docker', client)`, which wraps the
   client's `provision` and records each provisioned runtime as
   `{ id, provider: 'docker' }` until its disposal completes; a runtime whose
   disposal fails stays listed
   ([`vms.ts`](../../../packages/sandbox/src/lib/vms.ts));
3. the pool, `createSandpool` with `minIdle: 0`, `maxSandboxes: 10`,
   `maxCreateAttempts: 3`, the `log/v1` logger below, and a `create(identity)`
   factory that calls `createSandbox` with:

   | Field             | Value                                              |
   | ----------------- | -------------------------------------------------- |
   | `provider`        | the registry's wrapped provider                    |
   | `image`           | `DORIC_SANDBOX_IMAGE`                              |
   | `imagePullPolicy` | `if-not-present`                                   |
   | `resources`       | `{ cpuCount, memoryMiB, diskMiB: 4096 }`           |
   | `workspace`       | the acquisition's `identity` (the Project id)      |
   | `network`         | `{ mode: 'egress', ssh, dnsServers: ['1.1.1.1'] }` |

It then provides `sandbox/v1` and registers the start step.

### Acquisition

`acquire({ identity, signal })` calls `pool.acquire({ identity, signal })`,
passing `signal` only when one is given
([`src/host/sandbox.ts`](src/host/sandbox.ts)). With `minIdle: 0` the pool
keeps no warmed sandboxes: every acquisition carries an identity, and the pool
provisions a new sandbox for each identified acquisition, in arrival order,
with at most 10 sandboxes at once
([`sandpool`](../../../packages/sandpool/README.md#acquisition-and-ordering)).
Provisioning pulls the image when it is not present
([`docker-sandbox`](../../../packages/docker-sandbox/README.md#usage)).
Releasing the lease destroys that pool sandbox, and a released one is never
reused ([`sandpool`](../../../packages/sandpool/README.md#leases-and-disposal)); the
workspace's container goes only with its last lease, as
[Durable workspaces](#durable-workspaces) describes.

### Durable workspaces

The workspace of `identity` is the Docker volume `doric-workspace-<identity>`,
created when missing and bound at the sandbox root `/workspace`; provisioning
the same identity again reattaches it, so a Project's files survive its
container and a host restart. A container a previous host left for the
workspace is reused only when its settings (image, labels, network, CPU,
memory, disk, DNS, binds and ports) still match the request, so a change of
image, CPU or memory rebuilds the container on the Project's next acquisition
and keeps the volume
([`workspace.ts`](../../../packages/docker-sandbox/src/lib/workspace.ts),
[`reuse.ts`](../../../packages/docker-sandbox/src/lib/reuse.ts),
[`docker-sandbox`](../../../packages/docker-sandbox/README.md#durable-workspaces)).

While this process already serves a workspace, a further acquisition of the
same identity shares its container: the lease is a new pool sandbox with the
container's id, and the container is removed only with the last lease
([`provider.ts`](../../../packages/docker-sandbox/src/lib/provider.ts)). The
machine registry holds one entry per id, so releasing any of those leases
removes the container from `machines` and `machine` while another lease still
uses it ([`vms.ts`](../../../packages/sandbox/src/lib/vms.ts)).

`discard(identity)` calls `discardWorkspace(client, identity)`, which
force-removes every container labelled `doric.sandbox.workspace=<identity>`,
stopped ones included, and then force-removes the volume. Removing what is
already gone succeeds, so a repeated discard is safe
([`workspace.ts`](../../../packages/docker-sandbox/src/lib/workspace.ts)).

### Logging

The pool logs through a pino logger at level `debug` whose records go to
`log/v1` ([`src/host/logger.ts`](src/host/logger.ts)). The records are those
of [`sandpool`](../../../packages/sandpool/README.md#logging).
Each record maps to `log/v1` as follows:

- the pino level picks the `log/v1` method: 50 and above `error`, 40 and above
  `warn`, 30 and above `info`, below 30 `debug`, and a record without a numeric
  level `info`;
- `msg` becomes the message (empty when it is not a string);
- `level`, `time`, `pid` and `hostname` are dropped, and every other field,
  child bindings included (the pool's `component: 'sandpool'`), is passed as
  the record's fields;
- a record that cannot be parsed or delivered is dropped without an error.

### Start step

The start step registers on `doric.app.hooks/v1.onHostStartHook` and runs once
when the host starts ([`src/host/start.ts`](src/host/start.ts)). It names the
stage `sandbox_pool` through `doric.startup/v1.stage` and writes two `info`
lines through `doric.startup/v1.log`, with the call the hook received:

| Message                    | Fields                                                                                                                                                                                                                |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Configuring sandbox pool` | `sandboxProviderName: 'docker'`                                                                                                                                                                                       |
| `Sandbox pool configured`  | `sandboxProviderName: 'docker'`, `sandboxImage`, `sandboxResources` (`{ cpuCount, memoryMiB, diskMiB }`), `minIdle`, `maxSandboxes`, `maxCreateAttempts`, `networkMode: 'egress'`, `sshEnabled`, `dockerSocketShared` |

The step only reports the settings: the pool is built at activation.

### Deactivation

Deactivation disposes the start step's registration and then the pool, which
disposes every sandbox, leased ones included; the cleanup resolves when the
pool's disposal does ([`src/host/sandbox.ts`](src/host/sandbox.ts)).
Deactivation keeps every workspace volume.

## Data and side effects

- **Data.** The bundle stores nothing in Doric's storage. Each workspace is a
  Docker volume `doric-workspace-<identity>`, labelled
  `doric.sandbox.workspace=<identity>`, that lives until `discard`
  ([`workspace.ts`](../../../packages/docker-sandbox/src/lib/workspace.ts)).
  The machine registry and the pool are in memory and are lost with the
  process ([`vms.ts`](../../../packages/sandbox/src/lib/vms.ts)).
- **Side effects.** Engine API calls to the daemon: image pulls, container
  create, start and removal, exec and file transfer, volume create and
  removal ([`docker-sandbox`](../../../packages/docker-sandbox/README.md)).
  Each sandbox has outbound network access, with DNS at `1.1.1.1`; on Linux,
  egress needs the host's nftables firewall, and SSH needs the Dropbear binary
  and `ssh-keygen` on the host
  ([`docker-sandbox`](../../../packages/docker-sandbox/README.md#networking)).
  Log records go to `log/v1` and the start step's lines to
  `doric.startup/v1`.

## Limits

- At most 10 sandboxes at once; a further acquisition waits for capacity
  ([`src/host/sandbox.ts`](src/host/sandbox.ts),
  [`sandpool`](../../../packages/sandpool/README.md#creation-and-capacity)).
- Each sandbox has the configured CPUs and memory and a 4096 MiB writable
  layer. The disk limit applies only where the daemon supports per-container
  quotas; elsewhere the container is created without it. It never bounds the
  workspace volume
  ([`docker-sandbox`](../../../packages/docker-sandbox/README.md#writable-layer-disk-limits)).
- An identity must match `/^[A-Za-z0-9][A-Za-z0-9_.-]*$/`
  ([`workspace.ts`](../../../packages/docker-sandbox/src/lib/workspace.ts)).

## Errors and failure behavior

- **Activation.** An invalid `DORIC_SANDBOX_CPUS` or `DORIC_SANDBOX_MEMORY_MIB`
  throws, so the bundle provides no `sandbox/v1`
  ([`src/host/sandbox.ts`](src/host/sandbox.ts)). The shipped composition lists
  `sandbox/v1` under `required`, so the host then ends its start in recovery
  mode with exit code 1
  ([`required`](../../../docs/architecture/bundles/composition-and-distribution.md#required)).
- **Acquisition.** A failed sandbox creation (an unreachable daemon, an image
  that cannot be pulled, an invalid identity, on Linux a host without the
  nftables access egress needs, a missing Dropbear binary when SSH is on,
  which fails with `Docker SSH requires pinned Dropbear: <path>`, or an
  unsupported platform;
  [`docker-sandbox`](../../../packages/docker-sandbox/README.md#networking),
  [`host.ts`](../../../packages/docker-sandbox/src/lib/host.ts)) is retried with backoff; after 3
  consecutive failures the waiting acquisitions reject with
  `Sandpool could not create a sandbox after 3 attempts`, and a later
  acquisition starts a new batch of attempts. An aborted `signal` rejects the
  acquisition with an `AbortError`, and an acquisition after deactivation
  rejects with `Sandpool is not active`
  ([`sandpool.ts`](../../../packages/sandpool/src/lib/sandpool.ts),
  [`sandpool`](../../../packages/sandpool/README.md#errors)).
- **Discard.** An invalid identity rejects `discard` with
  `Sandbox workspace identity must match /^[A-Za-z0-9][A-Za-z0-9_.-]*$/u: <identity>`
  after the containers labelled with it are listed and removed; a daemon error
  rejects it first
  ([`workspace.ts`](../../../packages/docker-sandbox/src/lib/workspace.ts)).
- **Start step.** A failure of the start step stops the host's start
  ([Hooks](../../../docs/architecture/bundles/hooks.md#host-start-and-stop)).
- **Logging.** A log record never fails the pool
  ([`src/host/logger.ts`](src/host/logger.ts)).

## Build and test

```console
npx nx run bundle-docker:build
npx nx run bundle-docker:typecheck
npx nx run bundle-docker:test
```

The build compiles the host part and writes `bundles/sandboxes/docker/dist`
([`project.json`](project.json)); `doric-host:build-bundles` stages it into
`app/backend/doric-host/dist/bundles`
([`app/backend/doric-host/project.json`](../../../app/backend/doric-host/project.json)).
The `test` target compiles `src/` and `tests/` to `dist-tests` and runs them
with `node --test` ([`project.json`](project.json)).

The tests live in [`tests/`](tests):

- [`sandbox.test.ts`](tests/sandbox.test.ts) activates the host part through
  `createTestServices` over a fake provider and a fake client, and covers what
  `describe` answers, the provisioning input of an acquisition, the settings
  and their parsing, socket sharing, `discard`, the machine registry,
  deactivation and the log records;
- [`docker.test.ts`](tests/docker.test.ts) runs against a real daemon and is
  skipped unless `DORIC_TEST_SANDBOX=true`: it keeps a Project's file across
  two leases and loses it after `discard`; it needs a local daemon that has or
  can pull `node:22-slim` and, on Linux, the nftables access egress needs
  ([`docker-sandbox`](../../../packages/docker-sandbox/README.md#networking)).
