# layout

Apply these rules to `bundles/desktop/layout/`, after the root
[`AGENTS.md`](../../../AGENTS.md) and [`bundles/AGENTS.md`](../../AGENTS.md).

## Function

Keep this bundle to the frame of the workspace window and the slots it
declares. Add to it no navigation, no record and no feature's drawing: what
fills a slot, opens a tab, adds a panel view or registers a sidebar pane belongs
to the bundle that owns that feature. Never import `runtime/contracts` and
never read Projects, Threads or the selection: they belong to the bundle that
navigates, and Thread tabs to the bundle that draws Threads.

## Rules

- Read [`README.md`](README.md) for what the frame draws, its slots and its
  contracts before changing it, and
  [The layout bundle](../../../docs/architecture/bundles/layout.md) for how
  other bundles fill the shell.
- Put new client code in the folder of `src/client/` that matches it:
  `elements/` only the custom element `<layout-workspace>`; `views/` the frame,
  which reads the stores and composes the templates;
  `components/molecules/` a self-contained piece with no slot;
  `components/organisms/` a column's content that reads a store or a region;
  `components/templates/` the arrangement of columns and cards, taking its
  content as props; `hooks/` every `use*` hook; `stores/` the Zustand vanilla
  stores, one per contract; `domain/` pure rules about the layout's own data;
  `utility/` generic helpers that name no layout type, such as
  `move-item.ts`; `services/` the contract providers and
  `layout-services.ts`.
- Put a rule that can be stated in terms of its arguments in `domain/` or
  `utility/`, with a DOM-free test in `tests/`.
- Render the frame in a `tests/client/` test only through
  [`render-shell.ts`](tests/client/support/render-shell.ts), with stand-in
  items in the slots.
- Reach the activation services from a component only through
  `layoutServices()` of `services/layout-services.ts`.
- Take `ElementHost` and `useRegionItems` only from `desktop/ui/element-host`,
  and keep no local copy of them.
- Never name another bundle's element tag, tab kind or icon in the frame: draw
  a tab's or a panel view's icon and badge only as the element its owner names
  (`iconTag`, `badgeTag`), and keep no icon switch.
- Draw every slot with its `SHELL_*` constant from `src/contracts/index.ts`,
  never with a string written in the frame.
- Keep one `shell.sidebar` region element for the window and move it between
  the two forms; never render a second one, so that its items keep their
  elements when the form changes.
- Keep the quarantine notice in the frame's own sidebar column, outside
  `shell.sidebar`, so that it shows whatever fills that slot.
- Keep `src/client/styles.css` to the conversation footer's rule keyed on
  `[data-slot='workspace-footer']`: add no Tailwind directive or utility to it,
  and never add a rule for an editor or a terminal that another bundle draws.
- Make every input object schema of a contract `.strict()`, so that an unknown
  key fails `invalid_input`.
- Log a failure of an operation the frame starts itself with
  `console.error('Doric: …')`.
- Never rename or remove `--shell-conversation-footer-height`, a `data-slot`
  or an `aria-label` the frame draws: other bundles and
  [`app/desktop/doric-e2e`](../../../app/desktop/doric-e2e) select them; list
  them in the README when you add one.
- Add a slot in this order: declare its `SHELL_*` constant in
  `src/contracts/index.ts` with a doc comment and no type annotation
  (`export const SHELL_X = 'shell.x';`), so that a filler's
  `satisfies typeof SHELL_X` rejects a misspelled name; raise the minor of
  `version` in [`manifest.json`](manifest.json); draw it in
  [`src/client/views/workspace-view.tsx`](src/client/views/workspace-view.tsx),
  or in the template that holds its place, in each form that shows it; add a
  case with a stand-in item to `tests/client/shell.test.ts` for the
  conversation form or `tests/client/dashboard-shell.test.ts` for the page
  form; and add the slot to the README's Slots table.
- Add a contract or a contract member in this order: its types, schema and
  method table in `src/contracts/index.ts`; its state in a store under
  `stores/`, cleared by the cleanup of `activate` in `src/client/index.ts`; its
  provider in `services/`, given to `services.provide` in `activate`; its pure
  rules in `domain/`; and a `tests/<name>.test.ts` that drives the contract as
  another bundle calls it.
- Update the feature doc [UI redesign](../../../docs/features/ui-redesign.md)
  with any change to how the window looks or behaves, and the feature doc of
  any feature whose drawing the change moves:
  [Conversation](../../../docs/features/conversation.md),
  [Files](../../../docs/features/files.md) or
  [Terminal](../../../docs/features/terminal.md).
- Require in [`manifest.json`](manifest.json) only contracts that `core`
  provides; never require a contract of a bundle that fills a slot or calls a
  `layout.*` contract.
- Before adding an exception for this bundle, open
  [`tests/boundary-exceptions.json`](../../../tests/boundary-exceptions.json)
  and search it for `"bundle": "layout"`.

## Verify

- `npx nx run bundle-layout:typecheck`: run it after any change under `src/`,
  `stories/` or `.storybook/`.
- `npx nx run bundle-layout:test`: run it after any change under `src/`,
  `tests/` or `stories/support/`, whose `fake-host.ts`, `layout-host.tsx`,
  `tabs.ts` and `placeholder.tsx` the client tests use; the target builds the
  bundle first.
- `npx nx run bundle-layout:build`: run it after a change to `manifest.json`,
  `package.json`, a `tsconfig*.json` file, `src/contracts/` or
  `src/client/styles.css`.

## Generated files

None.
