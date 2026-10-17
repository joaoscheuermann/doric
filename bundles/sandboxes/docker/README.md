# Docker bundle

`docker` provides `sandbox/v1` over Docker. It runs in the generation
process next to `runtime`, and only one sandbox provider is enabled in a
composition.

Its host part reads `DORIC_SANDBOX_IMAGE` (default `node:22-bookworm`),
`DORIC_SANDBOX_SSH` (`true` enables SSH) and `DORIC_SANDBOX_DOCKER_SOCKET` at
activation. From them it builds the Docker client (`docker-sandbox`), the
registry of running VMs and the sandbox pool. Sharing the daemon socket is what
lets a sandbox build and run the images its Project describes; it is off by
default, because a sandbox that holds the socket has the daemon's authority on
the host. The pool provisions a named sandbox for each Project, with 1 CPU,
2048 MiB of memory and 4096 MiB of disk, and logs through `log/v1`. Each
Project keeps a durable workspace volume; discarding a deleted Project removes
it. Deactivation disposes the pool.
