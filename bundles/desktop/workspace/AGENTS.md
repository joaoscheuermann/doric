# workspace

These instructions apply to `bundles/desktop/workspace` and narrow
`bundles/AGENTS.md` (once it exists) and the root [`AGENTS.md`](../../../AGENTS.md).

## Function

Choosing what the window shows: Projects, Threads and the selection. A change
must keep the `app/desktop/doric-renderer` renderer's visible text, roles,
layout and quirks that the navigation carried when it left the layout. It
adds no frame and no slot of the window (they belong to the bundle that draws
the frame), and no drawing of a Thread's conversation or of its tab (they
belong to the bundle that draws Threads, which observes `onOpenThreadHook`).
Read [`README.md`](README.md) for what it draws, its contracts and its slots.

## Layers

- `src/contracts/`: the slot names, `DashboardFooterItemProps` and the
  `workspace.*` contracts (`index.ts`, with the sidebar's and the dashboard's
  in `navigation.ts`); no file of it imports `runtime/contracts`.
- `src/client/elements/`: the six elements, each a React root of its own.
- `src/client/components/`, `hooks/`, `stores/`, `queries/`: the sidebar, the
  tabs and the Dashboard, as they left the layout.
- `src/client/domain/`, `utility/`: pure modules, tested under
  `tsconfig.spec.json`.
- `src/client/services/`: the contract providers and `workspace-services.ts`,
  the activation services.

## Rules

- Projects and Threads are read from `runtime.records/v1`; call no method of
  `runtime/v2` or `runtime.threads/v1` (`tests/records-boundary.test.ts`).
- Only `workspace-sidebar` runs `useWorkspace`'s once-per-window effects
  (`useWorkspace({ effects: true })`); state two elements share lives in a
  module store (`stores/project-tabs.ts`, `stores/dashboard.ts`).
- Persistent work (the selection route, the owner follower, the
  `bindRecords` subscription) is bound to the activation services, never to an
  element's services (D9-17).
- A shell slot is written as a literal checked against `layout/contracts`
  with `import type`; the workspace draws no Thread tab and names no chat tag.
- Every host failure shows the message the REST path showed (R-ERR); the
  adapter in the runtime's `src/client/api/workspace-api.ts` owns those
  messages.

- The shadcn primitives are `desktop/ui/<name>`; `toast` comes only from
  `desktop/ui/sonner`, so a window has one toast store.
- Imports are relative with `.js` extensions; the package is ESM and the part
  is bundled by `bundle`'s build.
- The client part never imports `bundle`, `bundle/runtime` or
  `desktop/client`, and touches no DOM at module load.

## Footers

All footer text, including nested controls, uses `font-weight: 400`. Use a
semantic `footer` element or a `data-slot` ending in `-footer` so the shell's
footer rule (`app/desktop/doric-renderer/src/styles.css`) applies.

Labels and titles are 400 and running text 300, through desktop/ui's components
and the theme's root weight; add no per-control weight to reach them.

## Links

- [`manifest.json`](manifest.json): the contracts it provides, requires and
  may use.
- [`tests/boundary-exceptions.json`](../../../tests/boundary-exceptions.json):
  its entries, by the id `workspace`.
- [`README.md`](README.md): what it draws, its contracts, its slots, and how to
  build and test it.
- Feature docs: [bundle isolation](../../../docs/features/bundle-isolation.md),
  [thread archive](../../../docs/features/thread-archive.md).
