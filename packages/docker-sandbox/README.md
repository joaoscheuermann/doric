# docker-sandbox

`docker-sandbox` is the Docker provider of Doric's provider-neutral
[`sandbox`](../sandbox/README.md) runtime. It runs each sandbox as a container
on a reachable Docker daemon, Docker Desktop on macOS and Windows included. It
talks to the Docker Engine API directly over the daemon's Unix socket or
Windows named pipe, with no Docker CLI or SDK, applies CPU and memory limits to
every container and a writable-layer disk limit where the daemon's storage
driver supports one, keeps durable workspaces in
named volumes, and, when the network policy asks for them, installs a host
firewall and an SSH server for the sandbox.

Who uses it:

- the [`docker`](../../bundles/sandboxes/docker/README.md) sandbox bundle,
  which builds a client with `createDockerClient`, leases sandboxes through
  [`sandpool`](../sandpool/README.md) and deletes a Project's workspace with
  `discardWorkspace`
  ([`bundles/sandboxes/docker/src/host/sandbox.ts`](../../bundles/sandboxes/docker/src/host/sandbox.ts));
- tests of other bundles that need a real container, such as the
  [`terminal`](../../bundles/features/terminal/README.md) bundle's Docker test
  ([`bundles/features/terminal/tests/docker.test.ts`](../../bundles/features/terminal/tests/docker.test.ts)).

The feature doc [Sandboxes](../../docs/features/sandboxes.md) describes how a
Project's sandbox is chosen, leased and used across bundles. This README is the
package's complete description: its exports, behavior, side effects, limits
and errors.

Part of [Doric](../../README.md).

## Usage

```ts
import { createDockerClient } from 'docker-sandbox';
import { createSandbox } from 'sandbox';

const docker = createDockerClient();
await docker.ping();

const sandbox = await createSandbox({
  provider: docker,
  image: 'node:22-bookworm',
  imagePullPolicy: 'if-not-present',
  resources: { cpuCount: 2, memoryMiB: 2048, diskMiB: 4096 },
  network: { mode: 'disabled' },
  workspace: projectId, // optional: a durable workspace
});

try {
  const result = await sandbox.exec({ cmd: ['node', '--version'] });
  console.log(result.stdout);
} finally {
  await sandbox.dispose();
}
```

`createSandbox` validates the options, normalizes the network policy and calls
the client's `provision`; the session methods it adds on top are described in
the [`sandbox` README](../sandbox/README.md).

## Entry point

`package.json` has one entry point, `.` (`docker-sandbox`), which resolves to
[`src/index.ts`](src/index.ts) in the workspace (`@org/source` condition) and
to `dist/index.js` with its types once built
([`package.json`](package.json)). It re-exports:

| Export                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Kind     | Source                                                   |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------- | -------------------------------------------------------- |
| `createDockerClient`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | function | [`src/lib/docker.ts`](src/lib/docker.ts)                 |
| `discardWorkspace`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | function | [`src/lib/workspace.ts`](src/lib/workspace.ts)           |
| `DockerHttpError`, `DockerRequestTimeoutError`, `DockerRequestAbortedError`, `DockerProtocolError`, and the `DockerHttpErrorData` type                                                                                                                                                                                                                                                                                                                                                                                                                 | classes  | [`src/lib/classes/errors.ts`](src/lib/classes/errors.ts) |
| `DockerClient`, `CreateDockerClientOptions`, `DockerConnection`, `DockerTransport`, `DockerTransportRequest`, `DockerRequestQuery`, `DockerRequestOptions`, `DockerResponse`, and the input and result types of the client's calls (`DockerVersion`, `CreateContainerInput`, `PullImageInput`, `ImageInspect`, `ContainerRef`, `ContainerInspect`, `ListContainersInput`, `ContainerSummary`, `DockerStats`, `RemoveContainerOptions`, `CreateVolumeInput`, `RemoveVolumeOptions`, `ExecInput`, `ExecResult`, `ArchiveWriteInput`, `ArchiveReadInput`) | types    | [`src/lib/types/docker.ts`](src/lib/types/docker.ts)     |

It depends at runtime on `sandbox` (for the provider contract and the process
helpers) and `tslib`.

## `createDockerClient(options?)`

```ts
createDockerClient(options?: CreateDockerClientOptions): DockerClient
```

Returns a `DockerClient`: a `SandboxProvider` (its `provision` serves
`createSandbox`) that also exposes the Engine API calls it is built on
([`src/lib/docker.ts`](src/lib/docker.ts)). Creating a client contacts
nothing; the first call does.

### Options

```ts
interface CreateDockerClientOptions {
  readonly connection?: DockerConnection;
  readonly request?: DockerTransport;
  readonly timeoutMs?: number;
  readonly dropbearPath?: string;
  readonly statePath?: string;
  readonly exposeDockerSocket?: boolean;
  readonly exposeGpus?: boolean;
}

type DockerConnection =
  | { readonly kind: 'unix'; readonly socketPath?: string }
  | { readonly kind: 'namedPipe'; readonly pipePath?: string };
```

| Option               | Default                                                          | Meaning                                                                                                                                                 |
| -------------------- | ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `connection`         | `{ kind: 'namedPipe' }` on Windows, `{ kind: 'unix' }` elsewhere | Where the daemon listens. See [Connection](#connection).                                                                                                |
| `request`            | A Node `http` transport over the connection's socket             | Replaces the transport of every Engine API call, for tests. The live process stream of `start` does not use it (see [Live processes](#live-processes)). |
| `timeoutMs`          | None: requests have no timeout                                   | The timeout of every Engine API request whose own options name none.                                                                                    |
| `dropbearPath`       | `/opt/doric/firecracker/dropbearmulti`                           | The pinned Dropbear multi-call binary copied into a sandbox for SSH.                                                                                    |
| `statePath`          | `/var/lib/doric/docker`                                          | The host directory under which each container's SSH keys are written.                                                                                   |
| `exposeDockerSocket` | `false`                                                          | Mounts the daemon's Unix socket into every sandbox this client provisions. See [Sharing the Docker socket](#sharing-the-docker-socket).                 |
| `exposeGpus`         | `false`                                                          | Requests every GPU the daemon can hand out for each sandbox this client provisions. See [Sharing the GPUs](#sharing-the-gpus).                          |

Defaults are applied in [`src/lib/docker.ts`](src/lib/docker.ts) and
[`src/lib/mapping.ts`](src/lib/mapping.ts).

### Connection

The socket a `unix` connection uses is, in order: `socketPath`; the
`DOCKER_HOST` environment variable when it is `unix://<path>` or an absolute
path; `/var/run/docker.sock`. A `DOCKER_HOST` of any other form, such as
`tcp://`, is ignored, so only local sockets are reachable. A `namedPipe`
connection uses `pipePath`, else `//./pipe/docker_engine`
([`src/lib/mapping.ts`](src/lib/mapping.ts)).

### The transport and request control

Every Engine API call goes through one path
([`src/lib/docker.ts`](src/lib/docker.ts),
[`src/lib/mapping.ts`](src/lib/mapping.ts)):

- **Transport contract.** A `DockerTransport` takes a request and resolves a
  response:

  ```ts
  type DockerTransport = (
    request: DockerTransportRequest,
  ) => Promise<DockerResponse>;

  type DockerTransportRequest = DockerRequestOptions & {
    readonly method: string;
    readonly path: string;
    readonly query?: DockerRequestQuery; // Record<string, string | number | boolean | undefined>
    readonly headers?: Readonly<Record<string, string>>;
    readonly body?: unknown;
  };

  interface DockerRequestOptions {
    readonly signal?: AbortSignal;
    readonly timeoutMs?: number;
  }

  interface DockerResponse {
    readonly status: number;
    readonly headers: Readonly<
      Record<string, string | readonly string[] | undefined>
    >;
    readonly body: Uint8Array;
  }
  ```

- **Encoding.** Query values that are `undefined` are dropped and the rest are
  written with `URLSearchParams` (`true` becomes `"true"`). A `Uint8Array`
  body is sent as is with its `content-length`; any other body is sent as JSON
  with `content-type: application/json`. Paths carry no API version prefix, so
  the daemon serves its default API version. The default transport buffers the
  whole response body.
- **Timeout and abort.** A request's own `timeoutMs` wins over the client's.
  A request whose signal is already aborted fails with
  `DockerRequestAbortedError` before anything is sent. When the timer fires
  the request is aborted and fails with `DockerRequestTimeoutError`; when the
  caller's signal aborts, with `DockerRequestAbortedError`. The timer and the
  listener are cleared when the request settles.
- **Status check.** Each call names the HTTP statuses it accepts (listed
  below). Any other status throws `DockerHttpError` with the decoded response
  body. A JSON answer that lacks a required non-empty string field (`Id`) throws
  `Error('Docker response is missing string field: <key>')`; an empty body
  reads as `{}`.

### Engine API calls

Every call takes optional `DockerRequestOptions` (or carries `signal` and
`timeoutMs` in its input). A container is passed as a `ContainerRef` or its id
([`src/lib/docker.ts`](src/lib/docker.ts),
[`src/lib/types/docker.ts`](src/lib/types/docker.ts),
[`src/lib/mapping.ts`](src/lib/mapping.ts)).

| Call                                     | Request                                                                      | Accepted statuses | Result                                                                                                                                                                           |
| ---------------------------------------- | ---------------------------------------------------------------------------- | ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ping(options?)`                         | `GET /_ping`                                                                 | 200               | `void`                                                                                                                                                                           |
| `version(options?)`                      | `GET /version`                                                               | 200               | `DockerVersion`: `version`, `apiVersion`, `minApiVersion`, `gitCommit`, `goVersion`, `os`, `arch`, `kernelVersion` (strings when present), `experimental` (boolean), and `raw`   |
| `pullImage({ image }, options?)`         | `POST /images/create?fromImage=<image>`                                      | 200               | `void`, once the daemon's progress stream ends. Progress messages are not read, so an error reported inside a 200 stream is not detected.                                        |
| `inspectImage(image, options?)`          | `GET /images/<image>/json`                                                   | 200, 404          | `ImageInspect` (`id`, `raw`), or `undefined` on 404                                                                                                                              |
| `createContainer(input, options?)`       | `POST /containers/create?name=<name>`                                        | 201               | `ContainerRef`: `id` and the daemon's string `warnings`                                                                                                                          |
| `startContainer(container, options?)`    | `POST /containers/<id>/start`                                                | 204, 304          | `void`; a container already running (304) is not an error                                                                                                                        |
| `restartContainer(container, options?)`  | `POST /containers/<id>/restart`                                              | 204               | `void`; starts a stopped container                                                                                                                                               |
| `listContainers({ labels }, options?)`   | `GET /containers/json?all=true&filters={"label":[...]}`                      | 200               | `ContainerSummary[]` of every container, stopped ones included, carrying all the `key=value` labels: `id`, `running` (`State === 'running'`), `created` (seconds, `0` if absent) |
| `inspectContainer(container, options?)`  | `GET /containers/<id>/json`                                                  | 200               | `ContainerInspect` (see below)                                                                                                                                                   |
| `stats(container, input?)`               | `GET /containers/<id>/stats?stream=false`                                    | 200               | `DockerStats` (see [Resource readings](#resource-readings)); `input` is `{ cpuCount?, signal?, timeoutMs? }`                                                                     |
| `removeContainer(container, options?)`   | `DELETE /containers/<id>?force=&v=&link=`                                    | 204, 404          | `void`; a missing container is not an error. `options`: `force`, `volumes` (sent as `v`), `link`                                                                                 |
| `exec(container, input)`                 | `POST /containers/<id>/exec`, `POST /exec/<id>/start`, `GET /exec/<id>/json` | 201, 200, 200     | `ExecResult` (see [Exec](#exec))                                                                                                                                                 |
| `execDetached(container, input)`         | `POST /containers/<id>/exec`, `POST /exec/<id>/start` with `Detach: true`    | 201, 200          | The exec id; the command keeps running                                                                                                                                           |
| `putArchive(container, input, options?)` | `PUT /containers/<id>/archive?path=&noOverwriteDirNonDir=&copyUIDGID=`       | 200               | `void`; the tar `archive` bytes are extracted into the existing directory `path`                                                                                                 |
| `getArchive(container, { path }, opts?)` | `GET /containers/<id>/archive?path=<path>`                                   | 200               | The tar archive bytes of `path`                                                                                                                                                  |
| `createVolume({ name, labels? }, opts?)` | `POST /volumes/create`                                                       | 201               | `void`; an existing volume of that name is kept with its files                                                                                                                   |
| `removeVolume(name, options?)`           | `DELETE /volumes/<name>?force=`                                              | 204, 404          | `void`; a missing volume is not an error                                                                                                                                         |
| `start(container, input)`                | Exec over an HTTP upgrade                                                    | —                 | A live `SandboxProcess` (see [Live processes](#live-processes))                                                                                                                  |
| `provision(input)`                       | See [Provisioning](#provisioning)                                            | —                 | A `SandboxRuntime`                                                                                                                                                               |

`CreateContainerInput` maps to the create body: `image` → `Image`, `cmd` →
`Cmd`, `env` (`KEY=value` strings) → `Env`, `workingDir` → `WorkingDir`,
`labels` → `Labels`, `user` → `User`, `hostConfig` → `HostConfig` (passed
through as given), `networkDisabled` → `NetworkDisabled`, `exposedPorts`
(such as `'22/tcp'`) → `ExposedPorts`; `name` goes in the query. Absent fields
are left out.

`ContainerInspect` holds `id`; `ipAddress`, the first non-empty `IPAddress`
among the container's networks; `ports`, each published container port
(`'22/tcp'`) with its `{ hostIp, hostPort }` bindings whose host port is an
integer; and `raw`, the daemon's answer.

#### Exec

`exec` creates an exec with stdout and stderr attached, `Tty` from `input.tty`
(default `false`), `Cmd`, and `Env`, `WorkingDir` and `User` when given, starts
it attached, waits for the whole output, then inspects it. Without a TTY the
output is Docker's multiplexed stream: 8-byte frame headers (channel byte, then
a big-endian 32-bit length) split it into stdout (channel 1) and stderr
(channel 2); a truncated frame or an unknown channel throws
`DockerProtocolError`. With a TTY all output is stdout. The result holds
`exitCode` (the inspected `ExitCode`, or `null` when it is not a number),
`stdout` and `stderr` decoded as UTF-8, and the raw `stdoutBytes` and
`stderrBytes`. `signal` and `timeoutMs` apply to each of the three requests
separately; a timeout or an abort fails the call but does not stop the command
inside the container
([`src/lib/docker.ts`](src/lib/docker.ts),
[`src/lib/utils/demux.ts`](src/lib/utils/demux.ts),
[`src/lib/mapping.ts`](src/lib/mapping.ts)).

```ts
type ExecInput = DockerRequestOptions & {
  readonly cmd: readonly string[];
  readonly env?: readonly string[];
  readonly workingDir?: string;
  readonly user?: string;
  readonly tty?: boolean;
};
```

### Resource readings

`stats` reads one sample with `stream=false` and maps it to `DockerStats`
([`src/lib/mapping.ts`](src/lib/mapping.ts)):

- `cpuPercent` = (CPU usage delta ÷ system usage delta) × (online CPUs ÷
  `cpuCount`) × 100, clamped to 0–100, from `cpu_stats` and `precpu_stats`.
  Online CPUs are `online_cpus`, else the length of `percpu_usage`. It is
  absent when `cpuCount` is not given or not positive, or when a delta or the
  CPU count is missing or the system delta is not positive. It is thus the busy
  share of the container's own CPU quota: a container using every core it was
  given reads 100.
- `memoryUsedBytes` = `memory_stats.usage` minus the reclaimable file cache
  (`inactive_file` on cgroup v2, else `cache`, else 0), never below 0.
- `memoryLimitBytes` = `memory_stats.limit`.

A field the daemon does not report is left out.

## Provisioning

`provision(input: SandboxProvisionInput)` creates or reattaches the container
of one sandbox and returns its `SandboxRuntime`
([`src/lib/provider.ts`](src/lib/provider.ts)). The input comes from
`createSandbox`, which has already validated resources and normalized the
network policy, defaulting `root` to `/workspace`
([`sandbox` README](../sandbox/README.md)). The steps, in order:

1. **Name.** A given `name` must match `/^[A-Za-z0-9][A-Za-z0-9_.-]+$/`
   (at least two characters), else
   `Error('Docker container name must match <pattern>: <name>')`.
2. **Host preflight.** See [Networking](#networking). On a platform other than
   Linux, macOS or Windows, every provision fails here
   ([`src/lib/host.ts`](src/lib/host.ts)).
3. **Image.** With `imagePullPolicy: 'if-not-present'` the image is pulled only
   when `inspectImage` finds none; otherwise (`'always'` or absent) it is
   pulled on every provision.
4. **Container.** Without a `workspace`, a new container is created and
   started. With one, see [Durable workspaces](#durable-workspaces).
5. **Host side.** When the network mode is `egress`, the client inspects the
   container and configures the firewall and SSH (see
   [Networking](#networking) and [SSH](#ssh)). With mode `disabled` nothing is
   configured on the host; `createSandbox` turns any SSH request into mode
   `egress`, so a sandbox without network never has SSH.

### The container

Every sandbox container is created from one description, which reattachment
also compares against ([`src/lib/provider.ts`](src/lib/provider.ts)):

| Setting           | Value                                                                                                                         |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Command           | `sh -lc 'while :; do sleep 3600; done'`, so the image needs `sh`; commands run through exec                                   |
| Working directory | `input.root`                                                                                                                  |
| Labels            | `doric.sandbox=true`, `doric.sandbox.root=<root>`, and `doric.sandbox.workspace=<identity>` for a durable workspace           |
| `AutoRemove`      | `false`                                                                                                                       |
| `Binds`           | `doric-workspace-<identity>:<root>` for a durable workspace; `<daemon socket>:/var/run/docker.sock` when the socket is shared |
| `NetworkMode`     | `none` (and `NetworkDisabled: true`) for mode `disabled`; `bridge` for `egress`                                               |
| `Memory`          | `memoryMiB × 1024 × 1024` bytes                                                                                               |
| `NanoCpus`        | `cpuCount × 10⁹`                                                                                                              |
| `DeviceRequests`  | `[{ Count: -1, Capabilities: [['gpu']] }]` when the GPUs are shared; absent otherwise                                         |
| `StorageOpt.size` | `<diskMiB>M`, unless the daemon rejects it (see [Writable-layer disk limits](#writable-layer-disk-limits))                    |
| `Dns`             | `network.dnsServers`, when given                                                                                              |
| Ports             | With SSH: `22/tcp` exposed and published on `ssh.bindAddress`, at `ssh.port` or a port the daemon picks                       |

When starting the container or configuring its host side fails, the container
is force-removed (best effort) and the error is thrown.

### Writable-layer disk limits

Docker accepts `StorageOpt.size` only when its storage driver and backing
filesystem support per-container quotas; `overlay2`, for example, needs an XFS
backing filesystem mounted with `pquota`. The client first creates the
container with the limit. When the create fails with an error whose message or
body mentions `storage-opt`, `quota` or `size`, it creates it once more without
`StorageOpt.size`, so installations such as Docker Desktop on unsupported
filesystems still run sandboxes: CPU and memory stay enforced and the writable
layer is unmetered. When that retry, or a start, fails with such an error, the
client throws
`Error('Docker cannot enforce the requested <diskMiB> MiB writable-layer quota; use a quota-capable local Linux storage driver', { cause })`;
other errors are thrown as they are
([`src/lib/provider.ts`](src/lib/provider.ts)).

The limit bounds the writable layer only: a workspace volume keeps its files on
the host's own storage, so `diskMiB` does not bound what a sandbox writes into
its workspace. Use a quota-capable Docker host when disk isolation is
required.

### Durable workspaces

A sandbox provisioned with `workspace: <identity>` keeps its files in the named
volume `doric-workspace-<identity>`, bound at the sandbox root
([`src/lib/workspace.ts`](src/lib/workspace.ts),
[`src/lib/provider.ts`](src/lib/provider.ts)).

- **Identity.** It must match `/^[A-Za-z0-9][A-Za-z0-9_.-]*$/`, else
  `Error('Sandbox workspace identity must match <pattern>: <identity>')`.
- **Serialization.** Provisioning and releasing one identity run one at a time
  per client, in call order; a failed step does not block the next.
- **Sharing in one process.** The client keeps, per `DockerClient` object, the
  container it serves for each identity and a lease count. A second provision
  of an identity already served shares that container and its host side, and
  the container is torn down when the last lease is disposed; the second
  request's settings are not compared with the container's.
- **Reattachment.** Otherwise the client creates the volume (an existing one
  keeps its files; it is labelled `doric.sandbox.workspace=<identity>`), lists
  every container labelled with the identity, orders them running first, then
  newest, inspects each, and keeps the first whose settings match the request
  ([`src/lib/reuse.ts`](src/lib/reuse.ts)). The compared settings are the
  image, working directory, labels, exposed ports, network mode, memory,
  CPUs, writable-layer size, DNS servers, binds, port bindings and the count
  and capabilities of each device request, all read
  from the container's inspect answer; a setting the container does not report
  counts as different, so a container created without the disk limit is never
  kept. Every other container is force-removed, without its volumes, along with
  the firewall table and key directory it left on this host (best effort). A
  refused removal fails the provision with
  `AggregateError(failures, 'Docker duplicate removal failed')`. With no match,
  a new container is created.
- **Start.** A kept container with SSH is restarted, so an SSH daemon with keys
  this host no longer holds stops; any other kept container is started (a
  running one stays as it is). Its host side is then configured afresh.
- **Release.** Tearing a workspace container down never removes the named
  volume, so the files survive the container, a host restart and the next
  lease.

A sandbox without a workspace binds nothing: its files live in the container's
writable layer and go with the container.

### `discardWorkspace(client, identity)`

```ts
discardWorkspace(client: DockerClient, identity: string): Promise<void>
```

Deletes a durable workspace for good: it force-removes every container labelled
`doric.sandbox.workspace=<identity>`, one after the other, then force-removes
the volume `doric-workspace-<identity>`. A container or volume that is already
gone counts as removed, so a repeated call succeeds. An invalid identity throws,
after the labelled containers are removed and before the volume. The requests
use only the client's `timeoutMs`
([`src/lib/workspace.ts`](src/lib/workspace.ts)). It does not remove
host-side state and does not coordinate with leases this client still serves.

### Sharing the Docker socket

With `exposeDockerSocket: true` and a `unix` connection, every container the
client provisions binds the daemon's socket (the resolved connection socket) at
`/var/run/docker.sock`, where a Docker client looks by default, so code in the
sandbox can build and run images on the same daemon. A sandbox holding the
socket has the daemon's authority on the host, so the option is off by
default. A `namedPipe` connection has no socket to share and binds nothing
([`src/lib/docker.ts`](src/lib/docker.ts),
[`src/lib/provider.ts`](src/lib/provider.ts)).

### Sharing the GPUs

With `exposeGpus: true`, every container the client provisions asks the daemon
for every GPU it can hand out, the device request `docker run --gpus all`
sends. The daemon needs a GPU device driver for it, such as the NVIDIA
Container Toolkit on Linux or Docker Desktop's GPU support on Windows with
WSL2. When the daemon refuses the request with `could not select device
driver`, the client throws
`Error('Docker cannot give the sandbox GPUs; the daemon needs a GPU device driver such as the NVIDIA Container Toolkit', { cause })`
and does not retry without the GPUs. The image needs no GPU driver of its own:
the device driver mounts the driver's libraries and tools into the container
([`src/lib/docker.ts`](src/lib/docker.ts),
[`src/lib/provider.ts`](src/lib/provider.ts)).

### Networking

Mode `disabled` gives the container no network. Mode `egress` puts it on
Docker's bridge network; the firewall depends on the host platform
([`src/lib/host.ts`](src/lib/host.ts)). After start, every `egress` container
must have an IPv4 address
(`'Docker did not assign the sandbox an inspectable IPv4 address'`), on every
platform.

- **Linux (nftables).** Preflight requires a `unix` connection
  (`'Docker egress requires a local Linux Docker daemon'`), that the process
  share the host's network namespace (`/proc/self/ns/net` and
  `/proc/1/ns/net` are the same, else
  `'Docker egress requires access to the host network namespace'`), and that
  `nft list ruleset` succeed
  (`'Docker egress requires nftables CAP_NET_ADMIN access'`). After start, the
  client installs one table, `inet doric_docker_<first 12 characters of the id>`,
  deleting any table of that name first. Both chains are `type filter`,
  priority `-10`, policy `accept`. Its rules, for the container's
  address: on the host's `input` hook, accept established and related traffic
  from the sandbox and drop the rest, so the sandbox cannot open connections to
  the host; on the `forward` hook, accept established and related traffic to
  the sandbox, accept each `allowPrivate` exception (CIDR, protocol, ports),
  drop traffic to `0.0.0.0/8`, `10.0.0.0/8`, `100.64.0.0/10`, `127.0.0.0/8`,
  `169.254.0.0/16`, `172.16.0.0/12`, `192.0.0.0/24`, `192.168.0.0/16`,
  `198.18.0.0/15`, `224.0.0.0/4` and `240.0.0.0/4`, then accept UDP and TCP
  port 53 to each DNS server; everything else is accepted. Rules apply in that
  order, so a DNS server inside a dropped range stays unreachable unless an
  `allowPrivate` exception admits it.
- **macOS and Windows (Docker Desktop).** No firewall is installed; Docker
  Desktop's own bridge and NAT carry the traffic, so the ranges Linux drops are
  reachable.
- **Other platforms.** Provisioning fails with
  `Error('Docker egress is unsupported on platform: <platform>')`, whatever the
  network mode.

Host commands (`nft`, `ssh-keygen`, the Dropbear binary) run as child
processes with their stderr ignored; one that cannot start fails with
`'Docker host capability command could not start'`, one that exits non-zero
with `'Docker host capability command failed'`.

### SSH

When the policy enables SSH, preflight checks that `dropbearPath` is executable
(`'Docker SSH requires pinned Dropbear: <path>'`), on every platform. After
start the client ([`src/lib/host.ts`](src/lib/host.ts)):

1. recreates the key directory `<statePath>/<container id>` (mode `0700`) and
   generates an Ed25519 user key with `ssh-keygen` and an Ed25519 host key with
   `dropbearkey`, and reads the host's public key back with `dropbearkey -y`
   (`'Docker Dropbear host key is invalid'` when it holds no `ssh-ed25519`
   line);
2. as root in the container, creates `/run/doric-ssh` and `/root/.ssh`, copies
   in the Dropbear binary, the host key and the user's public key as
   `/root/.ssh/authorized_keys`, and sets their modes (a failing step throws
   `'Docker SSH setup command failed'`);
3. starts
   `/run/doric-ssh/dropbearmulti dropbear -F -E -s -g -j -k -p 22 -r /run/doric-ssh/host_key`
   detached, as root: password logins
   and local and remote port forwarding are off;
4. reads the published `22/tcp` binding (`'Docker did not publish the SSH port'`)
   and waits up to 5 s for it to accept connections, dialing `127.0.0.1` or
   `::1` for a wildcard bind (`'Docker SSH service did not become ready'`).

`ssh()` then answers `SandboxSshAccess`: `host` (`ssh.advertisedHost`, else the
bind address), `port` (the published host port), `username: 'root'`,
`privateKey` (the user's private key), `knownHosts` (`<host> <type> <key>`, or
`[<host>]:<port> …` when the port is not 22) and `hostKeyFingerprint` (the
SHA-256 fingerprint from `ssh-keygen -E sha256 -lf`;
`'Docker SSH host fingerprint is unavailable'` when it prints none). Without SSH, `ssh()` answers `undefined`.

## The runtime

The `SandboxRuntime` a provision returns
([`src/lib/provider.ts`](src/lib/provider.ts)):

| Member             | Behavior                                                                                                                                                                                                                                                        |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`               | The container id.                                                                                                                                                                                                                                               |
| `exec(input)`      | `exec` on the container, with `cwd` as the working directory; see [Exec](#exec).                                                                                                                                                                                |
| `start(input)`     | A live process; see [Live processes](#live-processes). Throws `'Docker client does not support live processes'` when the client has no `start`.                                                                                                                 |
| `putFile(path, b)` | Splits `path` at its last `/` and extracts a one-file tar (mode `0644`, owner 0:0) into that directory, which must exist ([`src/lib/utils/tar.ts`](src/lib/utils/tar.ts)). File names are written into the 100-byte tar name field; a longer name is truncated. |
| `getFile(path)`    | Reads the tar archive of `path` and answers the bytes of its first regular file; `'Archive did not contain a regular file'` for a directory, `'Tar entry extends past archive end'` for a truncated archive ([`src/lib/utils/tar.ts`](src/lib/utils/tar.ts)).   |
| `stats()`          | `stats` with the sandbox's `cpuCount` and `timeoutMs`, plus `cpuCount` and `at` (the ISO-8601 time of the reading).                                                                                                                                             |
| `ssh()`            | The SSH access, or `undefined`.                                                                                                                                                                                                                                 |
| `dispose()`        | Releases the lease. Concurrent and repeated calls share one release; a failed release is retried by the next call. The last lease of a container tears it down.                                                                                                 |

Only `stats` applies the provision's `timeoutMs`. `exec` uses the `timeoutMs`
of its own input, else the client's; `putFile` and `getFile` use the client's.
`start` sends its requests with the client's `timeoutMs`; its input's `timeoutMs`
terminates the process (see [Live processes](#live-processes)).

Tearing a container down deletes its firewall table and key directory, then
force-removes the container with its anonymous volumes (a named workspace
volume is kept). Failures are collected and thrown together as
`AggregateError(failures, 'Docker sandbox cleanup failed')`; a failed host
cleanup inside it is `AggregateError(failures, 'Docker host cleanup failed')`
([`src/lib/provider.ts`](src/lib/provider.ts),
[`src/lib/host.ts`](src/lib/host.ts)).

### Live processes

`start(container, input: SandboxProcessInput)` runs a process the caller can
stream, write to, resize and stop
([`src/lib/process.ts`](src/lib/process.ts)). The input and result types and
the output capture belong to [`sandbox`](../sandbox/README.md).

- **Launch.** It throws when `input.signal` is already aborted or `cmd` is
  empty (`'Sandbox command must not be empty'`). The command is wrapped so the
  shell writes its pid to `/tmp/doric-process-<uuid>` and then `exec`s the
  command; without a TTY the wrapper runs under `setsid -w`, so the process
  leads its own process group and the image needs `setsid`. The exec is
  created with stdin, stdout and stderr attached, `cwd`, `env` and `user`, and
  with a TTY of `rows` × `cols` (default 24 × 80) when `tty` is set. It fails
  with `'Docker did not return an exec ID'` when the daemon answers no id.
- **Attach.** It starts the exec over an HTTP upgrade (`Connection: Upgrade`,
  `Upgrade: tcp`) on the connection's socket directly, not through the
  `request` transport. The daemon must answer 101
  (`'Docker exec upgrade failed'`, or `… (<status>)` on a plain response);
  opening times out after 10 s (`'Docker exec opening timed out'`) and an
  abort fails it (`'Docker process opening aborted'`). When attaching fails,
  the process is killed (best effort) and the error is thrown.
- **Output.** With a TTY every byte is stdout. Without one the multiplexed
  frames are decoded as they arrive; channel 2 is stderr, any other is stdout;
  a frame longer than 16 MiB fails the process with
  `'Invalid Docker output frame'`.
- **Exit.** When the stream ends, the client polls the exec every 20 ms until
  it is no longer running, deletes the pid file (best effort) and resolves
  `result` with the exit code, or `null` when the daemon reports none. A stream
  error, or a close before the end
  (`'Docker process stream closed unexpectedly'`), kills the process and
  rejects `result`. A failure of the exit poll rejects `result` with its error,
  or with `'Docker process inspection failed'` when that is not an `Error`.
- **`write(data)`** writes to stdin; after exit it rejects with
  `'Sandbox process has exited'`.
- **`resize(cols, rows)`** does nothing without a TTY or after exit; it throws
  `RangeError('Terminal dimensions must be positive integers')` for other than
  positive integers, and otherwise calls `POST /exec/<id>/resize?h=<rows>&w=<cols>`.
- **`terminate()`** waits up to about 1 s for the pid file, then runs
  `sandbox`'s termination script in the container (5 s timeout), which kills
  the process and its descendants; a non-zero exit throws
  `'Could not terminate sandbox process'`. Repeated calls share one attempt;
  after exit it does nothing.
- **Timeout and abort.** `input.timeoutMs` and `input.signal` call
  `terminate()`; when that fails, the stream is destroyed with
  `'Sandbox process termination failed'`.

## Errors

The exported error classes ([`src/lib/classes/errors.ts`](src/lib/classes/errors.ts)):

| Class                       | Fields                                          | Message                                            | Thrown when                                                    |
| --------------------------- | ----------------------------------------------- | -------------------------------------------------- | -------------------------------------------------------------- |
| `DockerHttpError`           | `status`, `method`, `path` (with query), `body` | `Docker <method> <path> failed with HTTP <status>` | The daemon answers a status the call does not accept           |
| `DockerRequestTimeoutError` | `method`, `path`, `timeoutMs`                   | `Docker <method> <path> timed out after <ms>ms`    | A request outlives its timeout                                 |
| `DockerRequestAbortedError` | `method`, `path`                                | `Docker <method> <path> was aborted`               | The caller's signal aborts a request, or was aborted before it |
| `DockerProtocolError`       | —                                               | Describes the malformed frame                      | An exec's multiplexed output is malformed                      |

`DockerHttpError` takes a `DockerHttpErrorData` (`status`, `method`, `path`,
`body`). Other failures are a plain `Error`, `RangeError` or `AggregateError`
with the messages given above, or the underlying Node error passed through
unchanged: socket errors from the transport and the exec upgrade, `SyntaxError`
for a non-JSON body, and file-system errors on the host. Code that
reacts to a failure matches on the classes and on `DockerHttpError.status`;
reattachment, for example, treats a 404 when inspecting a listed container as a
container that is gone ([`src/lib/provider.ts`](src/lib/provider.ts)).

## Side effects and host state

- **Daemon objects:** containers labelled `doric.sandbox`, named volumes
  `doric-workspace-<identity>`, pulled images. Containers are removed on
  release; volumes only by `discardWorkspace`; images never.
- **Host files:** `<statePath>/<container id>/` with the user and host key
  pairs, removed on release and when a stale container is replaced.
- **Host firewall (Linux, egress):** one nftables table per container, removed
  on release and when a stale container is replaced.
- **Processes:** `nft`, `ssh-keygen` and the Dropbear binary on the host;
  Dropbear and the sleeping keep-alive shell inside each container.
- **Timers:** request timeouts, the 5 s SSH readiness wait, the 10 s exec
  opening timeout, the 20 ms exit poll.

## Development

The package is an Nx library. `build` and `typecheck` are inferred by the
`@nx/js/typescript` plugin; `test` and `e2e` are defined in
[`project.json`](project.json).

```console
npx nx build docker-sandbox
npx nx typecheck docker-sandbox
npx nx test docker-sandbox
```

`test` compiles the tests and runs `tests/*.test.ts` with `node --test`. The
tests in `tests/workspace.docker.test.ts` need a reachable daemon and run only
with `DORIC_TEST_SANDBOX=true`.

The e2e suite (`tests/*.e2e.ts`) provisions real containers and needs a
reachable daemon:

```console
npx nx run docker-sandbox:e2e
```
