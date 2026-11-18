# Layout Bundle Agent Instructions

These instructions apply to `bundles/desktop/layout` and narrow the root `AGENTS.md`.
The layout is the workspace window's frame and its slots: the sidebar column,
the title bar, the conversation, the viewer tabs, the side panel and the
footers. The navigation that fills the sidebar, the title bar and the page
form (Projects, Threads, the Dashboard) is the `workspace` bundle's since 5.0.0. It moved here from
`app/desktop/doric-renderer` in stage 9 and must keep that renderer's visible text,
roles, layout and quirks.

## Layers

`src/client/` keeps the renderer's layering:

```
src/client/
  components/{molecules,organisms,templates}/
  views/       pages: own the state, compose templates
  elements/    the custom elements `ui/v1` defines
  hooks/       every `use*` hook
  stores/      Zustand stores
  domain/      the vocabulary of the product (pure, tested)
  utility/     helpers stated only in terms of their arguments
  services/    the layout's own contract providers and activation services
  provisional/ stage-10 features kept in the layout's geometry
```

- A rule that can be stated in terms of its arguments belongs in `domain/` or
  `utility/` and has a test; code that needs React or the DOM is proven in the
  running app.
- The shadcn primitives are `desktop/ui/<name>`; `toast` comes only from
  `desktop/ui/sonner`, so a window has one toast store.
- Imports are relative with `.js` extensions; the package is ESM and the part
  is bundled by `bundle`'s build.

## Boundaries

- The client part never imports `bundle`, `bundle/runtime` or
  `desktop/client`, and touches no DOM at module load.
- The layout reads no records and imports nothing from `runtime/contracts`;
  Projects, Threads and the selection are `workspace`'s, and the Thread tabs
  and the views of the Threads on screen are the chat's.
- Persistent work is bound to the activation services, never to an element's
  services (D9-17).
- `src/client/styles.css` holds only the conversation footer's height, fill
  and blur (one rule keyed on `[data-slot='workspace-footer']`); the utilities
  this bundle uses are emitted by the shell's sorted sheet, so do not add
  Tailwind directives here (WP6 decision on the cascade). The Monaco slider
  rule ships with `files` and `git`, which draw Monaco editors, and the xterm
  rule with `terminal`; the layout names neither editor.
- The shell knows no consumer: a tab's or a panel view's icon is the element
  its owner names (`iconTag`), and the layout keeps no icon switch, no tab
  kinds of other bundles and no `readsSandbox`.
- `ElementHost` and `useRegionItems` come from the platform's
  `desktop/ui/element-host` (platform 1.8.0, `engines.doric` `^1.8.0`), with the
  `ui` and `regions` services passed in; keep no local copy.
- The frame keeps the quarantined-bundle notice in its own sidebar column,
  outside `shell.sidebar`, so it shows whoever fills the slot.

## Slots

- Every shell slot is a constant in `src/contracts/index.ts` (`SHELL_*`). The
  frame draws it as a value (`<Region name={SHELL_PANEL} />`,
  `useRegionItems(regions, SHELL_PANEL)`); a filler in another bundle writes
  `'shell.panel' satisfies typeof SHELL_PANEL` with an `import type`.
- `views/workspace-view.tsx` draws one of two forms: the page form while
  `shell.page` holds an item, the conversation form otherwise. It keeps one
  `shell.sidebar` region element and moves it between the forms, so its items
  (`workspace`'s `<workspace-sidebar>`) do not remount on a form switch.
- The tab owner lives in `stores/workspace-tabs.ts`; `layout.tabs/v2`
  `setOwner` sets it (`workspace` names it from the route), and the frame
  reads it. A failed close of a tab is reported with `console.error('Doric: …')`.

## Footers

All footer text, including nested controls, uses `font-weight: 400`. Use a
semantic `footer` element or a `data-slot` ending in `-footer` so the shell's
footer rule (`app/desktop/doric-renderer/src/styles.css`) applies.

Labels and titles are 400 and running text 300, through desktop/ui's components
and the theme's root weight; add no per-control weight to reach them.

## Tests

`tests/*.test.ts` are DOM-free and run under `node --test` from
`dist-tests`, which the test target removes first. Validate with:

```
npx nx run bundle-layout:typecheck
npx nx run bundle-layout:test
npx nx run bundle-layout:build
```
