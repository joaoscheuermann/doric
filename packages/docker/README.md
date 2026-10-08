# Docker sandbox provider

`docker` implements the provider-neutral `sandbox` runtime using the Docker
Engine API. It requests CPU, memory, and writable-layer disk limits whenever a
sandbox is provisioned.

## Use

With a reachable Docker daemon:

```ts
import { createDockerClient } from 'docker';
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

By default the client uses `/var/run/docker.sock` on Unix and Docker's named
pipe on Windows. Pass `connection` to `createDockerClient` to override it.
`DOCKER_HOST=unix://...` is also honored on Unix.

Networking is disabled unless the caller requests egress. Linux egress and SSH
need the host firewall and pinned Dropbear assets described by the Direct
runtime; Docker Desktop on macOS and Windows uses its native bridge/NAT path.

## Durable workspaces

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

The provider creates that volume when it is missing, binds it at the sandbox root
(`/workspace`), and records the workspace in the `doric.sandbox.workspace`
container label. Provisioning the same workspace again reattaches the volume, so
the files survive the container, a host restart, and the next sandbox lease for
that workspace. `discardWorkspace(client, identity)` removes the volume when the
workspace is deleted for good; removing a volume that is already gone succeeds,
so a repeated deletion is safe.

A sandbox without a workspace binds nothing and uses its own scratch writable
layer, which means its files are gone when the container is removed.

## Writable-layer disk limits

Docker accepts a writable-layer limit through `StorageOpt.size` only when its
storage driver and backing filesystem support per-container quotas. For
example, Docker's `overlay2` driver requires an XFS backing filesystem mounted
with the `pquota` option.

The provider first creates each sandbox with the requested disk limit. If the
daemon specifically rejects that option, it retries once without
`StorageOpt.size` so Docker Desktop installations on unsupported filesystems
can still run sandboxes. In that fallback, CPU and memory limits remain
enforced, but the sandbox writable layer is not size-limited by Docker.

`StorageOpt.size` limits the container writable layer only. A durable workspace
volume holds its files on the Docker host's own storage, so `diskMiB` does not
bound what a sandbox writes into its workspace.

Use a quota-capable Docker host when writable-layer disk isolation is required.

## Development

```console
npx nx build docker
npx nx test docker
```

The e2e suite provisions real containers and requires a reachable daemon:

```console
npx nx run docker:e2e
```
