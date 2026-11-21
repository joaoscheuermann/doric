# account

Apply these rules to `bundles/desktop/account/`, after the root
[`AGENTS.md`](../../../AGENTS.md) and [`bundles/AGENTS.md`](../../AGENTS.md).

## Function

Keep this bundle to drawing the reader's account status, the account menu it
opens and the menu's About line, and add to it no menu entry, status badge,
setting or command of its own: an entry or a badge belongs to the bundle that
owns what it opens or shows, which adds it as an item of `account.menu` or
`account.status`.

## Rules

- Read [`README.md`](README.md) for what the bundle draws, its slots and the
  props they take before adding to it.
- Keep the bundle client-only: add no `src/host/` or `src/desktop/` part, and
  persist nothing: no storage contract, no file, no `localStorage`.
- Keep [`src/contracts/index.ts`](src/contracts/index.ts) to slot names and
  the props types of their items, each with a doc comment that states what an
  item is; a data slot's comment also states what happens to an item that
  fails its type. It holds no contract id, so keep `provides` of
  [`manifest.json`](manifest.json) empty.
- Put a React component in `src/client/components/organisms/`, an element
  built with `defineReactElement` in `src/client/elements/`, a hook that reads
  a slot, with the store of the ids it reported, in `src/client/hooks/`, and
  a check or any other store in `src/client/domain/`.
- Never import `desktop/*`, and never touch the DOM, from
  `src/client/domain/`: [`tsconfig.spec.json`](tsconfig.spec.json) compiles
  that folder with `tests/*.test.ts`, which `node --test` runs with no window
  ([`project.json`](project.json)), and references only `packages/bundle`, so
  a `desktop/*` import fails the `test` target.
- Check the `props` of every item of a data slot with a function of
  `src/client/domain/` that returns only the fields it checks, or `undefined`,
  as [`menu-items.ts`](src/client/domain/menu-items.ts) does, and draw no item
  that fails.
- To add a field to a slot's props type, make it optional, add it to the
  slot's check in `src/client/domain/`, which returns only the fields it
  checks, and test both an item with it and one without it. Never remove,
  rename, narrow or make required a field of an existing props type: an item
  from a filler built against the earlier type then fails the check and is
  not drawn.
- Undo in the cleanup of `activate` ([`src/client/index.ts`](src/client/index.ts))
  everything `activate` adds, defines or follows.
- Reach `doric.about/v1` only through `AboutV1` in
  [`src/client/domain/about.ts`](src/client/domain/about.ts) and
  `services.whenAvailable`; never `use` it, and draw the menu without a
  version when it is absent or its answer fails.
- Execute a picked menu entry's command only through `commands/v1`, never
  await it in the click handler, and log a rejection with
  `console.error('Doric: the command <command> could not run:', error)`, as
  [`account-status.tsx`](src/client/components/organisms/account-status.tsx)
  does.
- Keep the `account.status` box a sibling of the "Account" button, never
  inside it, so that each badge stays its own Tab stop
  ([`account-status.tsx`](src/client/components/organisms/account-status.tsx)).
- Pass no props to an `account.menu` entry's icon element and add no size to
  it: fillers draw a 16 px SVG in `currentColor` against the menu item's `svg`
  rule of
  [`dropdown-menu.tsx`](../../../packages/desktop/src/components/dropdown-menu.tsx)
  and the `text-muted-foreground` colour that
  [`account-status.tsx`](src/client/components/organisms/account-status.tsx)
  sets on the icon's host.
- To add a data slot, export its name and its props type from
  [`src/contracts/index.ts`](src/contracts/index.ts), check its items in
  `src/client/domain/`, and read them through a hook in `src/client/hooks/`
  that calls `useRegionItems` of `desktop/ui/element-host`, drops each item
  that fails the check and reports it there once per id with a
  `console.error` that starts with `Doric:`, and exports a reset of the
  reported ids that the cleanup of `activate` calls, as
  [`use-menu-items.ts`](src/client/hooks/use-menu-items.ts) and
  `resetMenuReports` do. Draw the entries in
  [`account-status.tsx`](src/client/components/organisms/account-status.tsx).
- To add an element slot, export its name from
  [`src/contracts/index.ts`](src/contracts/index.ts), read its items with
  `useRegionItems` in
  [`account-status.tsx`](src/client/components/organisms/account-status.tsx)
  and draw each with `ElementHost`, passing its `props`, as the
  `account.status` badges are drawn.
- Test what `<account-status>` draws in [`tests/client/`](tests/client/)
  through `renderAccount` of
  [`render-account.ts`](tests/client/support/render-account.ts), seeding slot
  items and absent contracts through the fixture of
  [`fake-host.ts`](stories/support/fake-host.ts); test a module of
  `src/client/domain/` alone in `tests/*.test.ts`, or in
  `tests/client/*.test.ts` when the test renders one of its hooks.
- In a test file that calls `renderAccount`, never import `react-dom`,
  `src/client/` outside `src/client/domain/`, or
  `stories/support/account-host.tsx` statically: import them with
  `await import()` after the first `renderAccount`, as
  [`activation.test.ts`](tests/client/activation.test.ts) does.
- To make `commands/v1` fail, render `AccountStatus` yourself with
  `createRoot` of `react-dom/client`, imported with `await import()` after
  the first `renderAccount`. Pass it `services` whose `use` answers
  `commands/v1` with your stub and hands every other contract to
  `createFakeHost().services`. Wrapping the services given to `activate` does
  not reach the menu's pick, because the fake host's `ui/v1.create` gives
  `<account-status>` the fake host's own `services`, and its own
  `commands/v1.execute` always resolves
  ([`fake-host.ts`](stories/support/fake-host.ts)).
- To make `doric.about/v1` fail, pass `followAbout` (or `activate`) services
  whose `whenAvailable` answers it with a `get()` that rejects, as the
  `services` stub of [`about.test.ts`](tests/client/about.test.ts) does. The
  fake host's own `doric.about/v1` `get()` always resolves
  `{ version: '0.0.1' }`.
- Test what `activate` adds, and that its cleanup takes it back, in
  [`activation.test.ts`](tests/client/activation.test.ts).
- Add a story for each new state of `<account-status>` in
  `stories/components/organisms/`: bind the account with `bindAccount` of
  [`account-host.tsx`](stories/support/account-host.tsx) in a
  `useLayoutEffect`, call its `unbind` in the effect's cleanup, and render
  `AccountStatus` with the bound `services`, as
  [`account-status.stories.tsx`](stories/components/organisms/account-status.stories.tsx)
  does. Define each fixture at module scope.
- Before adding an exception for this bundle, open
  [`tests/boundary-exceptions.json`](../../../tests/boundary-exceptions.json)
  and search it for `"bundle": "account"`.
- Update [`README.md`](README.md) and the feature doc
  [ui-redesign](../../../docs/features/ui-redesign.md) with any change to what
  the account status or its menu draws, or to its slots.

## Verify

- `npx nx run bundle-account:typecheck`: run it after any change under
  `src/`, `stories/` or `.storybook/`.
- `npx nx run bundle-account:test`: run it after any change under `src/`,
  `tests/` or `stories/support/`, and run the tests only through this target,
  which builds the bundle first.
- `npx nx run bundle-account:build`: run it after a change to
  `manifest.json`, `package.json`, a `tsconfig*.json` file or
  `src/contracts/`.

## Generated files

None beyond those [`bundles/AGENTS.md`](../../AGENTS.md) lists.
