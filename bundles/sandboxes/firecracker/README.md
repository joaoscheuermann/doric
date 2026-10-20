# Firecracker bundle

`firecracker` runs each Doric Project in its own Firecracker microVM instead
of a Docker container, for deployments that want the agent's environment
isolated by a lightweight virtual machine. Unlike the
[`docker`](../docker/README.md) bundle, it keeps no durable workspace.

It is a sandbox bundle that provides `sandbox/v1` over Firecracker microVMs.
It runs in the generation process next to `runtime`, and only one sandbox
provider is enabled in a composition. See the
[main README](../../../README.md) for Doric as a whole and
[`packages/bundle`](../../../packages/bundle/README.md) for how bundles work.

## Configuration

The host part reads these variables at activation:

| Variable              | Default            | Meaning                              |
| --------------------- | ------------------ | ------------------------------------ |
| `DORIC_SANDBOX_IMAGE` | `node:22-bookworm` | The image each sandbox runs.         |
| `DORIC_SANDBOX_SSH`   | off                | `true` enables SSH into the sandbox. |

To use it in the shipped composition, set `DORIC_SANDBOX_PROVIDER=firecracker`
(the default is `docker`).

## How it works

From those settings the host part builds the Firecracker client
(`firecracker-sandbox`), the registry of running VMs and the sandbox pool, and
provides `sandbox/v1` over them. The Docker client is never created.

- The pool provisions a named sandbox for each Project, with 1 CPU, 512 MiB of
  memory and 4096 MiB of disk. It keeps no warm idle sandboxes, holds at most
  10, and retries a failed create up to 3 times.
- Sandboxes get outbound network access, with SSH when enabled.
- Firecracker keeps no durable workspace, so discarding a Project does
  nothing.
- The pool logs through `log/v1`, and the host's start step reports its
  settings at the `sandbox_pool` stage.
- Deactivation disposes the pool.

## Development

```console
npx nx build bundle-firecracker
npx nx typecheck bundle-firecracker
npx nx test bundle-firecracker
```

To rebuild and stage every bundle used by the Doric host:

```console
npx nx run doric-host:build-bundles
```
