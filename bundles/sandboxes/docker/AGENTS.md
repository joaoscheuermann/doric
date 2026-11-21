# docker

Apply these rules to `bundles/sandboxes/docker/`, after the root
[`AGENTS.md`](../../../AGENTS.md) and [`bundles/AGENTS.md`](../../AGENTS.md).

## Function

Keep this bundle to providing `sandbox/v1` over Docker, one sandbox with a
durable workspace per Project, and add to it no UI, setting stored by Doric,
tool, route or contract of its own: what a Project does with its sandbox
belongs to the bundle that leases it.

## Rules

- Read [`README.md`](README.md) for what the bundle does before adding to it.
- Keep the host part the bundle's only part, and add no `src/contracts/`:
  `sandbox/v1` is declared in `runtime/contracts`, so make a change to its
  shape in [`sandbox.ts`](../../runtime/runtime/src/contracts/sandbox.ts) of
  `runtime`, and implement it here and in the
  [`firecracker`](../firecracker/README.md) bundle in the same change.
- Declare in [`manifest.json`](manifest.json) every contract other than a
  `doric.*` one that you use, before you call it from `src/host/`.
- Before adding an exception for this bundle, open
  [`tests/boundary-exceptions.json`](../../../tests/boundary-exceptions.json)
  and search it for `"bundle": "docker"`.
- Read every deployment setting only through `dockerSandboxSettings` of
  `src/host/sandbox.ts`, from the `environment` option, and read `process.env`
  only as that option's default.
- Name a new setting `DORIC_SANDBOX_<NAME>`, give it a default, parse a number
  with `positiveInteger` so that an invalid value fails activation instead of
  falling back, and turn a switch on only for the exact value `true`.
- Report each new setting in the `Sandbox pool configured` line of
  `src/host/start.ts`, and keep that start step to reporting: never build or
  warm the pool there.
- Never contact the Docker daemon during activation: the client, the registry
  and the pool must stay idle until the first `acquire` or `discard`.
- Keep `minIdle` at `0`: every acquisition names a Project, and the pool never
  leases a warmed sandbox to a named acquisition.
- Never remove a workspace volume outside `discard`: deactivation disposes the
  pool and keeps every volume.
- Send the pool's records to `log/v1` only through `logV1Logger` in
  `src/host/logger.ts`, and never let a log record throw.
- Put a change to how Docker runs a container (volumes, reuse, network, disk
  limits, SSH) in [`packages/docker-sandbox`](../../../packages/docker-sandbox),
  and a change to leasing, capacity or retries in
  [`packages/sandpool`](../../../packages/sandpool), not in this bundle; keep
  `src/host/sandbox.ts` to choosing the values it passes them.
- Add the test of each change in the same change, in
  [`tests/sandbox.test.ts`](tests/sandbox.test.ts), through the file's `start`
  helper, which builds `createTestServices` of `bundle/testing` and activates
  `activateDockerSandbox({ environment, client })` over a fake provider and
  client; never make a test there need a Docker daemon.
- Put a test that needs a real daemon only in
  [`tests/docker.test.ts`](tests/docker.test.ts), skipped unless
  `DORIC_TEST_SANDBOX=true`.
- Update [`README.md`](README.md) in the same change, the feature doc
  [Sandboxes](../../../docs/features/sandboxes.md) with any change to the
  settings, the pool, workspaces, networking or SSH, and the feature doc
  [Projects and Threads](../../../docs/features/projects-and-threads.md) with
  any change to how a Project's sandbox is acquired, kept or discarded.

## Verify

- `npx nx run bundle-docker:typecheck`: run it after any change under `src/`.
- `npx nx run bundle-docker:test`: run it after any change under `src/` or
  `tests/`.
- `DORIC_TEST_SANDBOX=true npx nx run bundle-docker:test`: run it after a
  change to acquisition, workspaces or `discard`, on a host with a local Docker
  daemon that has or can pull `node:22-slim` and, on Linux, access to the host
  network namespace and nftables with `CAP_NET_ADMIN`; a missing prerequisite
  fails it with `Sandpool could not create a sandbox after 3 attempts`.
- `npx nx run bundle-docker:build`: run it after a change to `manifest.json`,
  `package.json` or a `tsconfig*.json` file.

## Generated files

None beyond those [`bundles/AGENTS.md`](../../AGENTS.md) lists.
