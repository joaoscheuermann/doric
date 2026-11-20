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

- Read [`README.md`](README.md) for what the host does before adding to it.
- Keep [`src/index.ts`](src/index.ts) the composition root, limited to the
  logger, the listener, the startup stages, the bundle boot, the bridge
  installation and the shutdown order; put any other logic in a module under
  `src/lib/`.
- Put bundle paths, composition reading, the start of the platform and the
  structural checks only in
  [`src/lib/bundles/boot.ts`](src/lib/bundles/boot.ts).
- Put desktop bridge behavior only under `src/lib/bridge/`: the namespace and
  its messages in [`socket.ts`](src/lib/bridge/socket.ts), the catalog the
  desktop downloads in [`catalog.ts`](src/lib/bridge/catalog.ts).
- Read an environment variable in the kernel only for the listener, the log
  file, the bundle path, the composition path or the `env` of an
  `alternatives` entry of [`composition.json`](composition.json); a variable a
  bundle reads belongs to that bundle. List every variable the kernel reads in
  the Configuration table of [`README.md`](README.md).
- Never import a bundle's package from `src/`: import only the platform
  packages `bundle`, `bundle/contracts`, `bundle/runtime` and `tool`, and
  libraries, and reach a bundle only through a contract id on
  `platform.services`. The `core` check of
  [`tests/support/boundaries.mjs`](../../../tests/support/boundaries.mjs),
  described in [boundaries](../../../docs/architecture/bundles/boundaries.md),
  fails on such an import; only files under `tests/` may import a bundle.
- When the kernel needs a value a bundle owns, keep it as a kernel constant
  and check it against the bundle in a test, as
  [`src/lib/socket-buffer.ts`](src/lib/socket-buffer.ts) and
  [`tests/socket-buffer.test.ts`](tests/socket-buffer.test.ts) do.
- Register no route on the listener from the kernel other than the bridge:
  hand the listener to the bundles through the `network` option of
  `startBundles` in [`src/lib/bundles/boot.ts`](src/lib/bundles/boot.ts), so
  that each bundle registers its own routes.
- Create the Socket.IO server in [`src/index.ts`](src/index.ts) with
  `destroyUpgrade: false`, because the `screen` bundle attaches its own
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
- To add a kernel feature, put its code in a module under `src/lib/` (a folder
  per area, as `bridge/` and `bundles/`), wire it in
  [`src/index.ts`](src/index.ts), and add its tests under `tests/` as
  `<module>.test.ts`.
- Test the host only through its public process, HTTP, Socket.IO and platform
  boundaries; reuse the helpers under `tests/helpers/` (`startHostProcess` in
  [`tests/helpers/host.ts`](tests/helpers/host.ts), `startKernel` in
  [`tests/helpers/platform.ts`](tests/helpers/platform.ts)) before adding
  another helper or adapter.
- Gate a test that needs PostgreSQL on `DORIC_TEST_DATABASE_URL`, as
  [`tests/persistence.test.ts`](tests/persistence.test.ts) does, and put a
  test of the composed host with PostgreSQL and a Docker sandbox only in
  `app/backend/doric-host-e2e`, run with `npx nx run doric-host-e2e:e2e`.
- Update [`README.md`](README.md) in the same change as any change to the
  host's startup, composition, bridge or configuration, and the architecture
  document that describes it:
  [composition-and-distribution](../../../docs/architecture/bundles/composition-and-distribution.md)
  for the composition, the catalog and the bridge,
  [observability](../../../docs/architecture/bundles/observability.md) for
  startup stages and logs, and
  [boundaries](../../../docs/architecture/bundles/boundaries.md) for the
  `core` and `lists` checks; update a feature doc in `docs/features/` only
  when it states the changed behavior.

## Verify

Run each command from the repository root.

- `npx nx run doric-host:build`: run it, knowing that it builds and stages
  every bundle first, after any change under `src/`, or to `project.json`,
  `package.json` or a `tsconfig*.json` file.
- `npx nx run doric-host:test`: run it after any change under `src/` or
  `tests/`, or to [`composition.json`](composition.json), and run the tests
  only through this target, which builds the host and its staged bundles
  first, because the tests load them from `dist/`.
- `DORIC_TEST_DATABASE_URL=<url of a dedicated PostgreSQL test database> npx nx run doric-host:test`:
  run it after a change that reaches storage, because without the variable
  the persistence cases skip.
- `npm run lint:test`: run it after a change to an import in `src/`, to
  [`composition.json`](composition.json), to
  [`project.json`](project.json) or to [`.Dockerfile`](.Dockerfile).

## Generated files

- The `references` of `tsconfig.lib.json` and `tsconfig.spec.json`: do not
  edit them by hand; run `npx nx sync`.
