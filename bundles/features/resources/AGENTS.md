# resources

Apply these rules to `bundles/features/resources/`, after the root
[`AGENTS.md`](../../../AGENTS.md) and [`bundles/AGENTS.md`](../../AGENTS.md).

## Function

Keep this bundle to reading, and showing to the reader, the CPU and memory use
of the selected Project's sandbox and of the machine the host runs on. Do not
add to it an action on what it observes (acquiring, starting, stopping or
restarting a lease or a sandbox), a setting, stored data or history, or an HTTP
route: serving a contract over REST belongs to the bundle that serves the host
API, and drawing the slot the badge sits in belongs to the bundle that owns the
slot.

## Rules

- Read [`README.md`](README.md) for what the bundle does before adding to it.
- Read a Project's sandbox only through `runtime.lease/v1.withLease` in the
  call's scope, in `src/host/`; never acquire a lease, and never let a
  provider's missing, empty or failing reading reject `project()`: answer an
  `unavailable` container from `src/host/container.ts`.
- Keep the machine's CPU sample in `src/host/machine.ts` as module state, and
  take every machine reading through `readHostResources`, so that each call
  advances the one sample.
- Add a member to `resources/v1` in three places in one change: the
  `Resources` interface and its schema in `resourcesMethods` in
  `src/contracts/index.ts`, and its method in `resourcesService` in
  `src/host/index.ts`, with `expose: 'desktop'` only when a window calls it.
- Add every new field of `HostResources` to `hostResourcesSchema` in the same
  change: the schema is strict, and a field it does not list fails `host()`
  with `invalid_output`.
- Add a scope key to `desktopScope` in [`manifest.json`](manifest.json) only
  when a method of `resources/v1` reads it.
- When a change adds or removes a method of `resources/v1` exposed to the
  desktop, or a key of its `desktopScope`, update
  [`bridge-exposure.snapshot.json`](../../../app/backend/doric-host/tests/bridge-exposure.snapshot.json)
  in the same change.
- Keep the client part in four layers, each importing only the ones before
  it: `src/client/domain/` for the reading types, formatting and thresholds as
  pure functions of their arguments, with no React, DOM or clock;
  `src/client/api/` for the calls to contracts, their checks and their error
  messages; `src/client/hooks/`
  for the React Query polling and service hooks; `src/client/monitor/` for the
  components.
- Call `resources/v1` from the window only through `createResourcesReads` in
  `src/client/api/resources.ts`, and turn every failure into one of
  `resourcesMessages` there.
- Never show a read failure on screen: keep the last reading of the query, and
  add no error state, toast or refresh button.
- Poll only in `useResourcesSnapshot`, called from `ConnectionBadge`, never
  from the popover's content, so that readings and the badge's tone advance
  while the popover is closed.
- Keep every threshold, interval and limit a named constant: thresholds in
  `src/client/domain/resources.ts`, intervals in
  `src/client/hooks/use-resources.ts`, the identifier limit in
  `src/client/api/resources.ts`.
- Advance the sustained-CPU count only through `useCpuSustain`, once per
  reading with a new `at`, and warn on CPU only from that sustained verdict.
- Draw the bundle's UI only inside `<resources-monitor>`, and register it only
  through `registerResourcesRegion` into `account.status`. Import
  `account/contracts` only with `import type`, keep the region name the literal
  `'account.status' satisfies typeof ACCOUNT_STATUS`, and list `account` under
  neither `requires` nor `optional`.
- Never import `workspace/contracts`: reach `workspace.selection/v1` only
  through the structural copy `WorkspaceSelectionV1` in
  `src/client/api/peers.ts`, and change that copy when `workspace` changes
  `current` or `subscribe`.
- Treat a contract the element uses without a provider as its fallback value
  (no Project, not connected) through `useService` and `useSubscribed` in
  `src/client/hooks/use-service.ts`; never throw for it.
- Change a glyph in `src/client/monitor/cloud-glyphs.ts` only as
  [`PROVENANCE.md`](PROVENANCE.md) says, and update its row there in the same
  change.
- Keep the `@source` line of `../../../../desktop/workspace/src/client` in
  `src/client/styles.css` exactly once, and add an `@source` line for each
  other bundle whose client classes this sheet must order with the window's
  other sheets.
- When you raise `version` in [`manifest.json`](manifest.json), update the
  version asserted in
  [`tests/workspace-sheet.test.ts`](tests/workspace-sheet.test.ts) in the same
  change.
- Put a fake used by both tests and stories in `stories/support/`, and add a
  story under `stories/monitor/` for each new state the badge or the popover
  draws.
- Add the tests of a change in the file for its layer:
  [`tests/contracts.test.ts`](tests/contracts.test.ts) for a schema,
  [`tests/resources.test.ts`](tests/resources.test.ts) for the host service
  and the window's reads, over its fake `runtime.lease/v1`,
  [`tests/domain.test.ts`](tests/domain.test.ts) for formatting and
  thresholds, and
  [`tests/client/connection-badge.test.ts`](tests/client/connection-badge.test.ts)
  for what the badge and the popover draw and the region item.
- Before adding an exception for this bundle, open
  [`tests/boundary-exceptions.json`](../../../tests/boundary-exceptions.json)
  and search it for `"bundle": "resources"`.
- Update the feature doc
  [Resource monitor](../../../docs/features/resource-monitor.md) with any
  change to what is read, how often, the thresholds, or what the badge and the
  popover show; update [Host API](../../../docs/features/host-api.md),
  [Projects and Threads](../../../docs/features/projects-and-threads.md) or
  [UI redesign](../../../docs/features/ui-redesign.md) when the change touches
  what they describe of this bundle.

## Verify

- `npx nx run bundle-resources:typecheck`: run it after any change under
  `src/`.
- `npx nx run bundle-resources:test`: run it after any change under `src/`,
  `tests/` or `stories/`, or to `manifest.json`; it compiles the tests from the
  sources and needs no build of this bundle.
- `npx nx run bundle-resources:build`: run it after a change to
  `manifest.json`, `package.json`, a `tsconfig*.json` file or `src/contracts/`,
  and before running a host or a window that loads this bundle.

## Generated files

None beyond those [`bundles/AGENTS.md`](../../AGENTS.md) lists.
