# firecracker

Apply these rules to `bundles/sandboxes/firecracker/`, after the root
[`AGENTS.md`](../../../AGENTS.md) and [`bundles/AGENTS.md`](../../AGENTS.md).

## Function

Keep this bundle to providing `sandbox/v1` over Firecracker microVMs, one
sandbox per acquisition, and add to it no UI, tool, route, setting page,
storage or other contract: what runs inside a sandbox belongs to the bundle
that runs it, and who acquires a sandbox and when belongs to the bundle that
holds the lease.

## Rules

- Read [`README.md`](README.md) for what the bundle does before changing it.
- Keep `src/host/` the bundle's only part, and add no `src/contracts/`:
  `sandbox/v1` is declared by `runtime` in `runtime/contracts`, and this bundle
  only implements it.
- Implement each method of `sandbox/v1` in `src/host/sandbox.ts` with
  `defineMethod({ ...sandboxMethods.<method>, execute })`, so that its schemas
  stay those of `runtime/contracts`; never change the shape of a method here.
  Add a member of `sandbox/v1` only in `runtime/contracts`, in the same change
  that implements it in this bundle and in `docker` and raises the minor of
  the `sandbox/v1` entry under `provides`, and the `version`, of both
  manifests, since either one is the composition's provider.
- Keep `describe` answering `{ provider: 'firecracker', durableWorkspace: false }`
  and `discard` a no-op that never disposes a running sandbox, as long as the
  `firecracker-sandbox` provider keeps nothing under a workspace name.
- Read every deployment setting only in `firecrackerSandboxSettings` in
  `src/host/sandbox.ts`, and read `process.env` only as the
  `options.environment ?? process.env` fallback in
  `activateFirecrackerSandbox`, so that tests inject the environment and
  the start step in `src/host/start.ts` reports the settings the pool uses.
- Build the provider only through `options.client`, with
  `createFirecrackerClient` as its default, so that tests pass a fake provider.
- Never contact the host's Firecracker setup during activation: keep
  `minIdle` at `0`, since every acquisition names a Project and an identified
  acquisition never takes a warmed sandbox, and leave the preflight to the
  first provisioning.
- Keep the start step to entering the stage `sandbox_pool` and writing its
  log lines through `doric.startup/v1`: it must never provision a sandbox and
  must never fail on a host without Firecracker support.
- Log the pool only through `logV1Logger` in `src/host/logger.ts`, which
  writes to `log/v1`; never write to the console, and never let a log record
  throw into the pool.
- Dispose in the cleanup that `activateFirecrackerSandbox` returns everything
  activation creates, as it disposes the start step and then the pool.
- Change how a microVM is built, networked, checked or cleaned up in
  `packages/firecracker-sandbox`, and how the pool leases, retries and orders
  in `packages/sandpool`, never in this bundle.
- Add a new deployment setting as a field of `firecrackerSandboxSettings`,
  pass it to `createSandbox` or `createSandpool` in `src/host/sandbox.ts`, and
  add it to the fields of the `Sandbox pool configured` line in
  `src/host/start.ts`.
- Keep `sandbox/v1@<version>` the only entry under `provides` of
  [`manifest.json`](manifest.json), and open that file to check it before any
  change to `src/host/sandbox.ts` that provides or registers a contract.
- Before adding an exception for this bundle, open
  [`tests/boundary-exceptions.json`](../../../tests/boundary-exceptions.json)
  and search it for `"bundle": "firecracker"`.
- Add the test of each change in the same change, in
  [`tests/sandbox.test.ts`](tests/sandbox.test.ts): activate the host part
  with `activateFirecrackerSandbox({ environment, client })` over
  `createTestServices` and the file's fake provider and recording `log/v1`,
  and never start a real Firecracker microVM from it.
- Update [`README.md`](README.md) in the same change as any change to the
  contract's answers, the settings, the limits, the start log lines or the
  failure behavior; update the feature doc
  [Sandboxes](../../../docs/features/sandboxes.md) with any change to the
  settings, the pool, workspaces, networking or SSH, and the feature doc
  [Projects and Threads](../../../docs/features/projects-and-threads.md) with
  any change to how a Project's sandbox is acquired, kept or discarded.

## Verify

- `npx nx run bundle-firecracker:typecheck`: run it after any change under
  `src/`.
- `npx nx run bundle-firecracker:test`: run it after any change under `src/`
  or `tests/`.
- `npx nx run bundle-firecracker:build`: run it after a change to
  `manifest.json`, `package.json` or a `tsconfig*.json` file, and before the
  host stages the bundle.

## Generated files

None beyond those [`bundles/AGENTS.md`](../../AGENTS.md) lists.
