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
  store nothing.
- Keep `src/contracts/index.ts` to slot names and the props types of their
  items, each with a doc comment that states what an item is and what happens
  to an item that fails its type; it holds no contract id, so keep `provides`
  of [`manifest.json`](manifest.json) empty.
- Put a React component in `src/client/components/organisms/`, an element
  built with `defineReactElement` in `src/client/elements/`, a hook that reads
  a slot in `src/client/hooks/`, and a check or store in
  `src/client/domain/`.
- Never import `desktop/*`, and never touch the DOM, from
  `src/client/domain/`: `tsconfig.spec.json` compiles that folder for the
  DOM-free tests and references `packages/bundle` only.
- Check the `props` of every item of a data slot in `src/client/domain/`
  before drawing it, draw no item that fails, and report each failing item
  once per id with a `console.error` that starts with `Doric:`; forget the
  reported ids in the activation's cleanup.
- Undo in the cleanup of `activate` (`src/client/index.ts`) everything
  `activate` adds, defines or follows.
- Reach `doric.about/v1` only through `AboutV1` in
  `src/client/domain/about.ts` and `services.whenAvailable`; never `use` it,
  and draw the menu without a version when it is absent or its answer fails.
- Execute a picked menu entry's command only through `commands/v1`, never
  await it in the click handler, and log a rejection with
  `console.error('Doric: the command <command> could not run:', error)`.
- Keep the `account.status` box a sibling of the "Account" button, never
  inside it, so that each badge stays its own Tab stop.
- Pass no props to an `account.menu` entry's icon element and add no size to
  it: fillers draw a 16 px SVG in `currentColor` against the menu item's `svg`
  rule and the host's muted colour.
- To add a slot, export its name and its props type from
  `src/contracts/index.ts`, check the items of a data slot in
  `src/client/domain/`, read them through a hook in `src/client/hooks/` with
  `useRegionItems`, and draw them in
  `src/client/components/organisms/account-status.tsx`.
- Test what `<account-status>` draws in `tests/client/*.test.ts` through
  `renderAccount` of `tests/client/support/render-account.ts`, seeding slot
  items and absent contracts through the fixture of
  `stories/support/fake-host.ts`; test a module of `src/client/domain/` alone
  in `tests/*.test.ts`, or in `tests/client/*.test.ts` when the test renders
  one of its hooks.
- Add a story for each new state of `<account-status>` in
  `stories/components/organisms/`, bound through `AccountHost` of
  `stories/support/account-host.tsx`.
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
