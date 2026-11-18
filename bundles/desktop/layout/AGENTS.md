# Layout Bundle Agent Instructions

These instructions apply to `bundles/desktop/layout` and narrow the root `AGENTS.md`.
The layout is the workspace frame of the desktop window: Projects and Threads,
the header, the side panel, the tabs and the footers. It moved here from
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
  queries/     TanStack Query keys, the client, the refresh queue
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
- Projects and Threads are read from `runtime.records/v1`, the runtime's
  records mirror; the layout calls no method of `runtime/v1` or
  `runtime.threads/v1`. The host adapter, the Project watch and the Thread
  views live in the runtime's client part.
- `runtime/contracts` is imported for types only; contract references are
  built from their IDs (D32).
- Persistent work (the selection route, timers, watches such as
  `watchThreadViews`, `watchThreadTabs` and the `bindRecords` subscription) is bound to the
  activation services, never to an element's services (D9-17).
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
- Every host failure shows the message the REST path showed (R-ERR); the
  adapter in the runtime's `src/client/api/workspace-api.ts` owns those
  messages.

## Slots and navigation elements

- Every shell slot is a constant in `src/contracts/index.ts` (`SHELL_*`). The
  frame draws it as a value (`<Region name={SHELL_PANEL} />`,
  `useRegionItems(regions, SHELL_PANEL)`); a filler in another bundle writes
  `'shell.panel' satisfies typeof SHELL_PANEL` with an `import type`.
- `views/workspace-view.tsx` draws one of two forms: the page form while
  `shell.page` holds an item, the conversation form otherwise. It keeps one
  `shell.sidebar` region element and moves it between the forms, so
  `<layout-sidebar>` does not remount on a form switch.
- The navigation fills the slots with the elements of
  `elements/navigation-elements.tsx` (`layout-sidebar`, `layout-project-tabs`,
  `layout-account-status`, `layout-dashboard`, `layout-sidebar-footer`) until
  steps 4(b) and 4(c) move them out. Each is a React root of its own, so:
  - only `layout-sidebar` runs `useWorkspace`'s once-per-window effects
    (`useWorkspace({ effects: true })`: Projects load, follow, selection
    persistence), because both forms draw it;
  - state two elements share lives in a module store: the Project tabs in
    `stores/project-tabs.ts` (restored by the activation), the Dashboard's
    page, search, highlight and create form in `stores/dashboard.ts`;
  - the tab owner lives in `stores/workspace-tabs.ts`; the activation's
    watcher sets it from the route with `tabOwnerOf`, and the frame reads it.
- `/projects` and `/projects/:projectId` are child routes of `/`, drawn by
  `elements/project-empty-element.tsx`.

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
