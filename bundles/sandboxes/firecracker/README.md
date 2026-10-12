# Firecracker bundle

`firecracker` provides `sandbox/v1` over Firecracker microVMs. It runs in the
generation process next to `runtime`, and only one sandbox provider is enabled
in a composition.

Its host part reads `DORIC_SANDBOX_IMAGE` (default `node:22-bookworm`) and
`DORIC_SANDBOX_SSH` (`true` enables SSH) at activation. From them it builds the
Firecracker client (`firecracker-sandbox`), the registry of running VMs and
the sandbox pool. The pool provisions a named sandbox for each Project, with
1 CPU, 512 MiB of memory and 4096 MiB of disk, and logs through `log/v1`.
Firecracker keeps no durable workspace, so discarding a Project does nothing.
Deactivation disposes the pool. The Docker client is never created.
