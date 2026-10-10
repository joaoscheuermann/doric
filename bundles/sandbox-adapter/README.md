# Sandbox adapter bundle

`sandbox-adapter` is the provisional `sandbox/v1` provider. It runs in the
generation process next to `runtime` and `direct` until the stage-10
`docker` and `firecracker` bundles replace it.

Its host part reads `DORIC_SANDBOX_PROVIDER` (`firecracker`, otherwise
Docker), `DORIC_SANDBOX_IMAGE` (default `node:22-bookworm`) and
`DORIC_SANDBOX_SSH` (`true` enables SSH). From them it builds the provider
client, the registry of running machines and the sandbox pool. The pool
provisions a named sandbox for each Project and logs through `log/v1`.
Discarding a Project removes its Docker workspace volume; on Firecracker it
does nothing. Deactivation disposes the pool.
