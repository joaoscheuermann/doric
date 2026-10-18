# Docker bundle

`docker` gives every Doric Project its own Docker container to work in, so
the agent can install packages, run servers and change files without touching
your machine. Each Project keeps a durable workspace volume, so its files
survive the container.

It is a sandbox bundle that provides `sandbox/v1`, the default sandbox
provider of the shipped host. It runs in the generation process next to
`runtime`, and only one sandbox provider is enabled in a composition. See the
[main README](../../../README.md) for Doric as a whole and
[`packages/bundle`](../../../packages/bundle/README.md) for how bundles work.

## Configuration

The host part reads these variables at activation:

| Variable                      | Default            | Meaning                                        |
| ----------------------------- | ------------------ | ---------------------------------------------- |
| `DORIC_SANDBOX_IMAGE`         | `node:22-bookworm` | The image each sandbox runs.                   |
| `DORIC_SANDBOX_SSH`           | off                | `true` enables SSH into the sandbox.           |
| `DORIC_SANDBOX_DOCKER_SOCKET` | off                | `true` shares the host's Docker daemon socket. |

Sharing the daemon socket is what lets a sandbox build and run the images its
Project describes; it is off by default, because a sandbox that holds the
socket has the daemon's authority on the host.

The shipped composition selects this bundle through
`DORIC_SANDBOX_PROVIDER` (default `docker`; the alternative is
[`firecracker`](../firecracker/README.md)).

## How it works

From those settings the host part builds the Docker client (`docker-sandbox`),
the registry of running VMs and the sandbox pool, and provides `sandbox/v1`
over them. Nothing is contacted until the first acquisition.

- The pool provisions a named sandbox for each Project, with 1 CPU, 2048 MiB
  of memory and 4096 MiB of disk, pulling the image if it is not present. It
  keeps no warm idle sandboxes, holds at most 10, and retries a failed create
  up to 3 times.
- Sandboxes get outbound network access, with SSH when enabled.
- Each Project keeps a durable workspace volume, which the sandbox reattaches;
  discarding a deleted Project removes it.
- The pool logs through `log/v1`, and the host's start step reports its
  settings at the `sandbox_pool` stage.
- Deactivation disposes the pool.

## Development

```console
npx nx build bundle-docker
npx nx typecheck bundle-docker
npx nx test bundle-docker
```

To rebuild and stage every bundle used by the Direct host:

```console
npx nx run doric-host:build-bundles
```
