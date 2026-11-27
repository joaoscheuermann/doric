# doric-host

Apply these rules to `app/backend/doric-host/`. Follow the root
[`AGENTS.md`](../../../AGENTS.md) first; this file narrows it.

## Function

Keep this project to the host kernel: reading the composition, starting the
bundle platform with the public address it is given, and letting the platform
boot every host part in its own process and bind the public listener. Never
add a product feature to it: Projects, Threads, the Doric configuration and
its settings (`host-config/v1`), credentials, sandbox settings, providers,
tools, REST routes, agent execution and every other contract belong to the
bundles that provide them.

## Rules

- Read [`README.md`](README.md) for what the host does before adding to it,
  at least [Configuration](README.md#configuration),
  [How the host is built](README.md#how-the-host-is-built),
  [Bundles and composition](README.md#bundles-and-composition),
  [Startup and failures](README.md#startup-and-failures),
  [Shutdown](README.md#shutdown) and [Validation](README.md#validation).
  The sections that describe the REST API, Socket.IO or the desktop bridge
  describe the kernel path the platform replaced; do not build on them.
- Keep [`src/index.ts`](src/index.ts) the composition root, limited to the
  logger, the startup record, the public address, the startup stages, the
  platform boot, the host-ready hook and the shutdown order; put any other
  logic in a module under `src/lib/`.
- Put bundle paths, the composition reading (with the alternatives its
  variables choose), the structural requirements, the platform boot and the
  host-ready hook only in
  [`src/lib/bundles/boot.ts`](src/lib/bundles/boot.ts).
- Add no desktop bridge and no server of your own: slice S63b deleted
  `src/lib/bridge/`, and the platform binds the public listener and serves
  `doric.catalog/v1` to the desktop on it.
- Read an environment variable in the kernel only for the listener, the log
  file, the bundle path, the composition path or the `env` of an
  `alternatives` entry of [`composition.json`](composition.json); a variable a
  bundle reads belongs to that bundle. List every variable the kernel reads in
  the list under [`## Configuration`](README.md#configuration) of
  [`README.md`](README.md).
- Never import a bundle's package from `src/`: import only the platform
  packages `bundle`, `bundle/contracts`, `bundle/platform`, `bundle/runtime`
  and `tool`, and third-party npm packages; import no other package under
  `packages/` without a reason stated in the change. Reach a bundle only
  through a contract id on `platform.services`. The `core` check of
  [`tests/support/boundaries.mjs`](../../../tests/support/boundaries.mjs),
  described in [boundaries](../../../docs/architecture/bundles/boundaries.md),
  fails on such an import; only files under `tests/` may import a bundle.
- Declare every package a file under `src/` imports in `dependencies` of
  [`package.json`](package.json), and every package only `tests/` imports in
  `devDependencies`. Then run `npx nx sync`.
- When the kernel needs a value a bundle owns, keep it as a kernel constant
  and check it against the bundle in a test.
- Register no HTTP route and no Socket.IO namespace from the kernel: the
  platform binds the public listener and the gateway serves the bundles'
  `doric.api.*` services, and a bundle serves its own HTTP prefix on its own
  loopback listener behind the gateway (`doric.network/v1` was removed in
  slice S69). The kernel calls no `listen` and creates no server.
- Decide which contracts and bundles the host needs only in the `required`
  entry of [`composition.json`](composition.json); never hard-code a
  structural provider in `src/`.
- Never write a `bundles/<group>/<id>` path or a `"bundle-<id>"` name into
  [`project.json`](project.json) or [`.Dockerfile`](.Dockerfile), and never
  put an id with no `manifest.json` under `bundles/` into
  [`composition.json`](composition.json): the `lists` check of
  [`tests/support/boundaries.mjs`](../../../tests/support/boundaries.mjs),
  described in [boundaries](../../../docs/architecture/bundles/boundaries.md),
  fails on either.
- Set the startup stage before each new startup step, so that a failure is
  logged at the stage it happened in: [`src/index.ts`](src/index.ts) sets its
  own through `startupStage`, and
  [`src/lib/bundles/boot.ts`](src/lib/bundles/boot.ts) sets its steps through
  the `startup` sink (`network_binding` before the platform binds).
- Boot through `startHostPlatform` and await `hostReady` before
  `Doric listening`, as [`src/index.ts`](src/index.ts) does: the platform
  binds the public listener inside the boot, and `hostReady` runs the
  bundles' `onHostReadyHook` once the host accepts requests.
- Keep the shutdown order of [`src/index.ts`](src/index.ts):
  `platform.shutdown()` closes the public listener, runs the
  `onHostStopHook`s and stops every bundle process within the shutdown
  deadline; then flush the log and exit 0, once.
- To add a feature that a user or a client sees, add it to a bundle under
  `bundles/`, following [`bundles/AGENTS.md`](../../../bundles/AGENTS.md),
  and not here.
- To add a kernel feature, put its code in a module under `src/lib/`: a
  folder per area, as `bundles/`, or a single file directly under `src/lib/`
  for a lone constant. Define code that boots,
  starts or checks the platform as an exported function of
  [`src/lib/bundles/boot.ts`](src/lib/bundles/boot.ts), and call every new
  function from [`src/index.ts`](src/index.ts) at its place in the startup or
  shutdown order above, as `bundlePaths`, `hostComposition` and `hostReady`
  are.
- To give the platform a new host-provided value or `doric.*` implementation,
  add it to `StartHostPlatformOptions` and pass it to `startPlatform` in
  [`src/lib/bundles/boot.ts`](src/lib/bundles/boot.ts), as `startup` is;
  build the value in its own module under `src/lib/`, or, when it needs only
  what `startHostPlatform` already holds, build it inside it, as
  `composition` (`overridesPath`, `read`, `resolve`) is built.
  State its shape in the architecture document of that contract, as
  [composition-and-distribution](../../../docs/architecture/bundles/composition-and-distribution.md)
  does for `doric.catalog/v1` and
  [observability](../../../docs/architecture/bundles/observability.md) for
  `doric.startup/v1`.
- Put each test file directly in `tests/`, never in a subfolder: the `test`
  target of [`project.json`](project.json) runs only `tests/*.test.js`. Name
  each test `<area>[-<aspect>].test.ts`, as `boot.test.ts` and
  `bundles.test.ts`. Put fixtures under `tests/fixtures/` and helpers
  under `tests/helpers/`.
- Write tests with `node:test` and `node:assert/strict`, as the existing tests
  do.
- Test the host only through its public process, its `doric.api.*` HTTP
  services and the platform. Reuse the helpers under `tests/helpers/` before
  adding another helper or adapter: `startHostProcess` and `freshDatabase` in
  [`tests/helpers/host.ts`](tests/helpers/host.ts), `startPlatform` (and
  `startKernel`, which adds the credential service and the configuration
  store over it) in
  [`tests/helpers/platform.ts`](tests/helpers/platform.ts),
  `persistenceFixture` in
  [`tests/helpers/persistence-fixture.ts`](tests/helpers/persistence-fixture.ts),
  `callApi`, `openStream` and `reasonOf` in
  [`tests/helpers/api.ts`](tests/helpers/api.ts) and `bundlePid` in
  [`tests/helpers/processes.ts`](tests/helpers/processes.ts).
- Gate a test that needs PostgreSQL on `DORIC_TEST_DATABASE_URL`, as
  [`tests/persistence.test.ts`](tests/persistence.test.ts) does. Gate a case
  that starts a sandbox on `DORIC_TEST_SANDBOX === 'true'` as well, as
  [`tests/secret-logs.test.ts`](tests/secret-logs.test.ts) does. Put a
  workflow across Projects, Threads, a real sandbox and a generation respawn,
  as [`integration.test.ts`](../doric-host-e2e/tests/integration.test.ts)
  has, in `app/backend/doric-host-e2e`.
- Update [`README.md`](README.md) in the same change as any change under
  `src/` or to [`composition.json`](composition.json), and the architecture
  document that describes it:
  [composition-and-distribution](../../../docs/architecture/bundles/composition-and-distribution.md)
  for the composition, the catalog and the public listener,
  [observability](../../../docs/architecture/bundles/observability.md) for
  startup stages and logs, and
  [boundaries](../../../docs/architecture/bundles/boundaries.md) for the
  `core` and `lists` checks. Update the feature docs that state host
  behavior when the change alters what they state:
  [host-api](../../../docs/features/host-api.md) and
  [bundle-isolation](../../../docs/features/bundle-isolation.md).

## Verify

Run each command from the repository root.

- `npx nx run doric-host:build`: run it, knowing that it builds and stages
  every bundle first, after any change under `src/`, or to `project.json`,
  `package.json` or a `tsconfig*.json` file.
- `npx nx run doric-host:typecheck`: run it after any change under `src/`.
- `npx nx run doric-host:test`: run it after any change under `src/` or
  `tests/`, or to [`composition.json`](composition.json), and run the tests
  only through this target, which builds the host and its staged bundles
  first, because the tests load them from `dist/`.
- `DORIC_TEST_DATABASE_URL=<URL of a dedicated PostgreSQL server whose role may create databases and schemas; each case creates its own and drops it> npx nx run doric-host:test`:
  run it after a change that reaches storage, because without the variable
  the persistence cases skip.
- `DORIC_TEST_DATABASE_URL=<url> DORIC_TEST_SANDBOX=true npx nx run doric-host:test`:
  run it after a change that reaches a sandbox, because without
  `DORIC_TEST_SANDBOX=true` the sandbox cases skip.
- `DORIC_TEST_DATABASE_URL=<url> DORIC_TEST_SANDBOX=true npx nx run doric-host-e2e:e2e`:
  run it after a change to a workflow across Projects, Threads, a real
  sandbox and a generation respawn, as
  [`integration.test.ts`](../doric-host-e2e/tests/integration.test.ts) has;
  it fails without both variables.
- `npm run lint:test`: run it after a change to an import in `src/`, to
  [`composition.json`](composition.json), to
  [`project.json`](project.json) or to [`.Dockerfile`](.Dockerfile).

## Generated files

- The `references` of `tsconfig.lib.json` and `tsconfig.spec.json`: do not
  edit them by hand; run `npx nx sync`.
