# doric-host

Apply these rules to `app/backend/doric-host/`. Follow the root
[`AGENTS.md`](../../../AGENTS.md) first; this file narrows it.

## Function

Keep this project to the host kernel: reading the composition, starting the
bundle platform, owning the HTTP listener and Socket.IO server the bundles
share, and serving the generic desktop bridge `/doric/bridge` with its bundle
catalog. Never add a product feature to it: Projects, Threads, the Doric
configuration and its settings (`host-config/v1`), credentials, sandbox
settings, providers, tools, REST routes, Socket.IO namespaces other than
`/doric/bridge` and agent execution belong to the bundles that provide them.

## Rules

- Read [`README.md`](README.md) for what the host does before adding to it,
  at least [Configuration](README.md#configuration),
  [How the host is built](README.md#how-the-host-is-built),
  [Startup and failures](README.md#startup-and-failures),
  [Shutdown](README.md#shutdown),
  [The desktop bridge](README.md#the-desktop-bridge) and
  [Validation](README.md#validation).
- Keep [`src/index.ts`](src/index.ts) the composition root, limited to the
  logger, the listener, the startup stages, the bundle boot, the bridge
  installation and the shutdown order; put any other logic in a module under
  `src/lib/`.
- Put bundle paths, composition reading, the call to `startKernel` and the
  structural checks only in
  [`src/lib/bundles/boot.ts`](src/lib/bundles/boot.ts).
- Put desktop bridge behavior only under `src/lib/bridge/`: the namespace and
  its messages in [`socket.ts`](src/lib/bridge/socket.ts), the catalog the
  desktop downloads in [`catalog.ts`](src/lib/bridge/catalog.ts).
- Read an environment variable in the kernel only for the listener, the log
  file, the bundle path, the composition path or the `env` of an
  `alternatives` entry of [`composition.json`](composition.json); a variable a
  bundle reads belongs to that bundle. List every variable the kernel reads in
  the list under [`## Configuration`](README.md#configuration) of
  [`README.md`](README.md).
- Never import a bundle's package from `src/`: import only the platform
  packages `bundle`, `bundle/contracts`, `bundle/runtime` and `tool`, and
  third-party npm packages; import no other package under `packages/` without
  a reason stated in the change. Reach a bundle only through a contract id on
  `platform.services`. The `core` check of
  [`tests/support/boundaries.mjs`](../../../tests/support/boundaries.mjs),
  described in [boundaries](../../../docs/architecture/bundles/boundaries.md),
  fails on such an import; only files under `tests/` may import a bundle.
- Declare every package a file under `src/` imports in `dependencies` of
  [`package.json`](package.json), and every package only `tests/` imports in
  `devDependencies`. Then run `npx nx sync`.
- When the kernel needs a value a bundle owns, keep it as a kernel constant
  and check it against the bundle in a test, as
  [`src/lib/socket-buffer.ts`](src/lib/socket-buffer.ts) and
  [`tests/socket-buffer.test.ts`](tests/socket-buffer.test.ts) do.
- Register no HTTP route and no Socket.IO namespace other than
  `/doric/bridge` from the kernel: hand the listener to the bundles through
  the `network` option of `startBundles` in
  [`src/lib/bundles/boot.ts`](src/lib/bundles/boot.ts), so that each bundle
  registers its own routes and namespaces.
- Create the Socket.IO server in [`src/index.ts`](src/index.ts) with
  `destroyUpgrade: false`, because the `screen-relay` bundle attaches its own
  `upgrade` listener to the shared server, and with `maxHttpBufferSize` set to
  `SOCKET_MAX_HTTP_BUFFER_BYTES` from
  [`src/lib/socket-buffer.ts`](src/lib/socket-buffer.ts).
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
- Let the bridge in [`src/lib/bridge/socket.ts`](src/lib/bridge/socket.ts)
  call only the methods a provider's contract exposes to the desktop, and
  never add an allowlist of its own.
- When a change alters which contract methods or scope keys a desktop window
  may use, update
  [`tests/bridge-exposure.snapshot.json`](tests/bridge-exposure.snapshot.json)
  by hand in the same change.
- Set `startupStage` in [`src/index.ts`](src/index.ts) before each new startup
  step, so that a failure is logged at the stage it happened in.
- Call `assertStructural` before `platform.start()`, and install the bridge
  and await `platform.ready()` before `server.listen`, in
  [`src/index.ts`](src/index.ts), so that no request arrives before the
  bundles are ready.
- Keep the shutdown order of [`src/index.ts`](src/index.ts): stop the
  `watchStructural` subscription, close the listener and the Socket.IO server,
  then `platform.shutdown()`, then `platform.stop()`.
- To add a feature that a user or a client sees, add it to a bundle under
  `bundles/`, following [`bundles/AGENTS.md`](../../../bundles/AGENTS.md),
  and not here.
- To add a kernel feature, put its code in a module under `src/lib/`: a
  folder per area, as `bridge/` and `bundles/`, or a single file directly
  under `src/lib/` for a lone constant, as
  [`socket-buffer.ts`](src/lib/socket-buffer.ts). Define code that boots,
  starts or checks the platform as an exported function of
  [`src/lib/bundles/boot.ts`](src/lib/bundles/boot.ts), and call every new
  function from [`src/index.ts`](src/index.ts) at its place in the startup or
  shutdown order above, as `assertStructural` and `watchStructural` are.
- To give the platform a new host-provided value or `doric.*` implementation,
  add it to `StartBundlesOptions` and pass it to `startKernel` in
  [`src/lib/bundles/boot.ts`](src/lib/bundles/boot.ts), as `startup` is;
  build the value in its own module under `src/lib/`, or, when it needs only
  what `startBundles` already holds, build it inside `startBundles`, as
  `distribution` is built from [`catalog.ts`](src/lib/bridge/catalog.ts).
  State its shape in the architecture document of that contract, as
  [composition-and-distribution](../../../docs/architecture/bundles/composition-and-distribution.md)
  does for `doric.catalog/v1` and
  [observability](../../../docs/architecture/bundles/observability.md) for
  `doric.startup/v1`.
- Put each test file directly in `tests/`, never in a subfolder: the `test`
  target of [`project.json`](project.json) runs only `tests/*.test.js`. Name
  each test `<area>[-<aspect>].test.ts`, as `bridge.test.ts` and
  `bridge-exposure.test.ts`. Put fixtures under `tests/fixtures/` and helpers
  under `tests/helpers/`.
- Write tests with `node:test` and `node:assert/strict`, as the existing tests
  do.
- Test the host only through its public process, HTTP, Socket.IO and platform
  boundaries. Reuse the helpers under `tests/helpers/` before adding another
  helper or adapter: `startHostProcess` and `freshDatabase` in
  [`tests/helpers/host.ts`](tests/helpers/host.ts), `startKernel` and
  `kernelOver` in [`tests/helpers/platform.ts`](tests/helpers/platform.ts),
  `persistenceFixture` in
  [`tests/helpers/persistence-fixture.ts`](tests/helpers/persistence-fixture.ts),
  `openStream` and `reasonOf` in [`tests/helpers/api.ts`](tests/helpers/api.ts)
  and `bundlePid` in [`tests/helpers/processes.ts`](tests/helpers/processes.ts).
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
  for the composition, the catalog and the bridge,
  [observability](../../../docs/architecture/bundles/observability.md) for
  startup stages and logs, and
  [boundaries](../../../docs/architecture/bundles/boundaries.md) for the
  `core` and `lists` checks. Update the feature docs that state host
  behavior when the change alters what they state:
  [host-api](../../../docs/features/host-api.md),
  [bundle-isolation](../../../docs/features/bundle-isolation.md) and
  [attachments](../../../docs/features/attachments.md), the last for the
  socket buffer.

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
