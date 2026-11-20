# workspace

Apply these rules to `bundles/desktop/workspace/`, after the root
[`AGENTS.md`](../../../AGENTS.md) and [`bundles/AGENTS.md`](../../AGENTS.md).

## Function

Keep this bundle to choosing what the window shows: the Dashboard of Projects,
the Project tabs, each Project's tree of Threads and the selection. Add to it
no frame and no slot of the window, which belong to the bundle that draws the
frame; no drawing of a Thread's conversation or of a Thread tab, which belong
to the bundle that draws Threads and answers `onOpenThreadHook`; and no store
of Projects or Threads, which belong to the bundle that owns the records.

## Rules

- Read [`README.md`](README.md) for what the bundle draws, its contracts, its
  slots and its data before you change or add to it.
- Read and write Projects and Threads only through `runtime.records/v1`; never
  name `runtime/v2` or `runtime.threads/v1` under `src/`:
  [`tests/records-boundary.test.ts`](tests/records-boundary.test.ts) fails on
  them.
- Never import `runtime/contracts` from `src/contracts/`.
- Declare a service interface of this bundle and its method schemas in
  [`src/contracts/navigation.ts`](src/contracts/navigation.ts) or
  [`src/contracts/index.ts`](src/contracts/index.ts), and give it its
  `workspace.*` id only in `src/contracts/index.ts`.
- Provide each contract from a `create*` function in `src/client/services/`
  built with `defineService` and the method schemas of `src/contracts/`, and
  call `services.provide` for it in
  [`src/client/index.ts`](src/client/index.ts).
- Reach the window's services from a component, a hook or a store only
  through `workspaceServices()` of
  [`src/client/services/workspace-services.ts`](src/client/services/workspace-services.ts).
- Keep each element in `src/client/elements/` a React root of its own, defined
  with `defineReactElement` and, when it draws, wrapped in
  `WorkspaceProviders`; register it
  with `ui.define` in `src/client/index.ts`.
- Keep state that two element roots share in a module store under
  `src/client/stores/`, never in React state, and reset a new store in the
  cleanup that `activate` returns.
- Run once-per-window work (loads, the route selection, follows) only inside
  `useWorkspace({ effects: true })` of
  [`src/client/hooks/use-workspace.ts`](src/client/hooks/use-workspace.ts),
  which only `<workspace-sidebar>` calls; every other element calls
  `useWorkspace()` without `effects`.
- Keep the selection only in the window path, written through
  [`src/client/stores/route-selection.ts`](src/client/stores/route-selection.ts);
  never write it to `localStorage`.
- Never write the message of a host failure in this bundle: show the message
  the error carries, which the runtime's
  [`workspace-api.ts`](../../runtime/runtime/src/client/api/workspace-api.ts)
  writes, store it with the workspace store's `fail` or `report`, and give a
  new error code its title in
  [`src/client/domain/error-catalog.ts`](src/client/domain/error-catalog.ts).
- Let no workspace action reject: catch its failure and store it as the
  workspace error.
- Check the `props` of a data item of a slot this bundle declares with a pure
  function in `src/client/domain/`, as
  [`footer-items.ts`](src/client/domain/footer-items.ts) does, and never draw
  an item that fails it.
- Keep `src/client/domain/`, `utility/`, `stores/`, `services/` and
  `queries/` free of React components, hooks and JSX, and of `.tsx` files,
  and give them no DOM access that fails outside a window, so that
  [`tsconfig.spec.json`](tsconfig.spec.json) compiles them and the DOM-free
  tests of `tests/` run them.
- To add a feature, put a rule in `src/client/domain/`, a drawing in
  `src/client/components/molecules/` or `organisms/` under an existing
  element, and a new slot item as a new element in `src/client/elements/`,
  added with `regions.add` in `src/client/index.ts` and disposed in its
  cleanup.
- To let other bundles extend the window's navigation, add a member to
  `workspace.selection/v1`, `workspace.sidebar/v1` or `workspace.dashboard/v1`,
  or a slot to `src/contracts/index.ts`; never read or name a bundle that
  fills them.
- Test a component, a hook or an element through `renderWorkspace` of
  [`tests/client/support/render-workspace.ts`](tests/client/support/render-workspace.ts).
- When the client starts to use a contract that
  [`stories/support/fake-host.ts`](stories/support/fake-host.ts) does not
  provide, add an in-memory provider of it there in the same change, so that
  the stories and `tests/client/` still boot.
- When you change `version`, `provides`, `requires` or `optional` of
  [`manifest.json`](manifest.json), change
  [`tests/manifest.test.ts`](tests/manifest.test.ts) to match in the same
  change.
- Read [UI redesign](../../../docs/features/ui-redesign.md) before changing
  what the sidebar, the tabs or the Dashboard draw, and
  [thread archive](../../../docs/features/thread-archive.md) before changing
  the Chat and Archived tabs, archive, pin or restore.
- Update the feature doc of the area you change in the same change:
  [Projects and Threads](../../../docs/features/projects-and-threads.md) for
  creating, renaming, coloring, selecting and deleting,
  [thread archive](../../../docs/features/thread-archive.md) for the archive,
  [UI redesign](../../../docs/features/ui-redesign.md) for what the window
  draws, and [error messages](../../../docs/features/error-messages.md) for
  errors.
- Before adding an exception for this bundle, open
  [`tests/boundary-exceptions.json`](../../../tests/boundary-exceptions.json)
  and search it for `"bundle": "workspace"`.

## Verify

- `npx nx run bundle-workspace:typecheck`: run it after any change under
  `src/`, `stories/` or `.storybook/`.
- `npx nx run bundle-workspace:test`: run it after any change under `src/`,
  `tests/` or `stories/support/`, and run the tests only through this target,
  which builds the bundle first.
- `npx nx run bundle-workspace:build`: run it after a change to
  `manifest.json`, `package.json`, a `tsconfig*.json` file or `src/contracts/`.

## Generated files

None beyond those [`bundles/AGENTS.md`](../../AGENTS.md) lists.
