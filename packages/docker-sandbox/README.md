# Docker sandbox provider

`docker-sandbox` runs Doric's provider-neutral [`sandbox`](../sandbox/README.md)
runtime on any reachable Docker daemon, including Docker Desktop on macOS and
Windows. It talks to the Docker Engine API directly, applies CPU, memory and
writable-layer disk limits to every sandbox, and keeps durable workspaces in
named volumes so a Project's files survive container and host restarts. It is
the easiest way to give an agent an isolated environment on a developer
machine.

Part of [Doric](../../README.md).

## Highlights

- **No extra tooling.** A small Engine API client over the Unix socket or the
  Windows named pipe; no Docker CLI or SDK dependency.
- **Resource limits.** CPU, memory and, where the host supports it,
  writable-layer disk limits on every container.
- **Durable workspaces.** Files live in a per-workspace Docker volume that
  outlives the container; `discardWorkspace` removes it for good.
- **Network off by default.** Egress and SSH only when the caller asks for
  them.
- **Opt-in Docker access.** `exposeDockerSocket` lets code in the sandbox
  build and run images with the same daemon, for trusted deployments only.

## Usage

With a reachable Docker daemon:

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
});

try {
  const result = await sandbox.exec({ cmd: ['node', '--version'] });
  console.log(result.stdout);
} finally {
  await sandbox.dispose();
}
```

Without `imagePullPolicy: 'if-not-present'`, the image is pulled on every
provision.

## API

| Export                               | Purpose                                                                          |
| ------------------------------------ | -------------------------------------------------------------------------------- |
| `createDockerClient(options?)`       | A `DockerClient`: a `SandboxProvider` plus Engine API calls.                     |
| `discardWorkspace(client, identity)` | Removes a durable workspace's containers and volume.                             |
| `DockerHttpError` and friends        | `DockerRequestTimeoutError`, `DockerRequestAbortedError`, `DockerProtocolError`. |

`createDockerClient` options:

| Option               | Notes                                                                   |
| -------------------- | ----------------------------------------------------------------------- |
| `connection`         | `{ kind: 'unix', socketPath? }` or `{ kind: 'namedPipe', pipePath? }`.  |
| `timeoutMs`          | Default timeout for Engine API requests.                                |
| `exposeDockerSocket` | Mounts the daemon's Unix socket into each sandbox; off by default.      |
| `dropbearPath`       | Pinned Dropbear binary for SSH; `/opt/doric/firecracker/dropbearmulti`. |
| `statePath`          | Host-side state directory; `/var/lib/doric/docker`.                     |
| `request`            | A custom `DockerTransport`, for tests.                                  |

Besides `provision`, a `DockerClient` exposes `ping`, `version`, `pullImage`,
`inspectImage`, container create/start/restart/list/inspect/remove, `exec`,
archive transfer, `stats` and volume calls.

## Behavior

### Connection

By default the client uses `/var/run/docker.sock` on Unix and Docker's named
pipe on Windows. Pass `connection` to `createDockerClient` to override it.
`DOCKER_HOST=unix://...` is also honored on Unix.

### Sharing the Docker socket

Pass `exposeDockerSocket: true` to mount the daemon's Unix socket into every
sandbox the client provisions, at `/var/run/docker.sock`, so code inside a
sandbox can build and run images with the same daemon. It is off by default: a
sandbox that holds the socket has the daemon's authority on the host. A
connection that is not a Unix socket has no socket to share.

### Networking

Networking is disabled unless the caller requests egress. Linux egress needs
the host nftables firewall (with network-admin access) described by the Direct
runtime; Docker Desktop on macOS and Windows uses its native bridge/NAT path.
SSH needs the pinned Dropbear binary at `dropbearPath` and `ssh-keygen` on
the host.

### Durable workspaces

A sandbox created with a `workspace` keeps its files in the Docker volume
`doric-workspace-<workspace>`:

```ts
const sandbox = await createSandbox({
  provider: docker,
  image: 'node:22-bookworm',
  resources: { cpuCount: 2, memoryMiB: 2048, diskMiB: 4096 },
  workspace: projectId,
});
```

- The workspace identity must start with a letter or digit and contain only
  letters, digits, `_`, `.` and `-`.
- The provider creates the volume when it is missing, binds it at the sandbox
  root (`/workspace`), and records the workspace in the
  `doric.sandbox.workspace` container label.
- Provisioning the same workspace again reattaches the volume, so the files
  survive the container, a host restart, and the next sandbox lease for that
  workspace.
- Concurrent leases of one workspace from the same client share one
  container, which is removed with the last lease.
- A container an earlier host left for the workspace is reused when its
  settings still match the request; duplicates and mismatched containers are
  removed.
- `discardWorkspace(client, identity)` removes the workspace's containers and
  then its volume when the workspace is deleted for good. Removing what is
  already gone succeeds, so a repeated deletion is safe.

A sandbox without a workspace binds nothing and uses its own scratch writable
layer, which means its files are gone when the container is removed.

### Writable-layer disk limits

Docker accepts a writable-layer limit through `StorageOpt.size` only when its
storage driver and backing filesystem support per-container quotas. For
example, Docker's `overlay2` driver requires an XFS backing filesystem mounted
with the `pquota` option.

The provider first creates each sandbox with the requested disk limit. If the
daemon specifically rejects that option, it retries once without
`StorageOpt.size` so Docker Desktop installations on unsupported filesystems
can still run sandboxes. In that fallback, CPU and memory limits remain
enforced, but the sandbox writable layer is not size-limited by Docker.

`StorageOpt.size` limits the container writable layer only. A durable
workspace volume holds its files on the Docker host's own storage, so
`diskMiB` does not bound what a sandbox writes into its workspace.

Use a quota-capable Docker host when writable-layer disk isolation is
required.

## Development

```console
npx nx build docker-sandbox
npx nx typecheck docker-sandbox
npx nx test docker-sandbox
```

The e2e suite provisions real containers and requires a reachable daemon:

```console
npx nx run docker-sandbox:e2e
```
