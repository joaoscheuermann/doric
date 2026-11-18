# workspace

These instructions apply to `bundles/desktop/workspace` and narrow
`bundles/AGENTS.md` (once it exists) and the root [`AGENTS.md`](../../../AGENTS.md).

## Function

Choosing what the window shows: Projects, Threads and the selection. A change
adds no frame and no slot of the window (they belong to the bundle that draws
the frame), and no drawing of a Thread's conversation or of its tab (they
belong to the bundle that draws Threads, which observes `onOpenThreadHook`).
Read [`README.md`](README.md) for what it draws, its contracts and its slots.

## Layers

- `src/contracts/`: the slot names, `DashboardFooterItemProps`, the
  `workspace.*` contracts (`index.ts`, with the sidebar's and the dashboard's
  in `navigation.ts`), and the three `layout.*` ids of the transition
  (`transition.ts`, the only file that imports `runtime/contracts`).
- `src/client/elements/`: the six elements, each a React root of its own.
- `src/client/components/`, `hooks/`, `stores/`, `queries/`: the sidebar, the
  tabs and the Dashboard, as they left the layout.
- `src/client/domain/`, `utility/`: pure modules, tested under
  `tsconfig.spec.json`.
- `src/client/services/`: the contract providers and `workspace-services.ts`,
  the activation services.

## Rules

- Projects and Threads are read from `runtime.records/v1`; call no method of
  `runtime/v1` or `runtime.threads/v1` (`tests/records-boundary.test.ts`).
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

## Links

- [`manifest.json`](manifest.json): the contracts it provides, requires and
  may use.
- [`tests/boundary-exceptions.json`](../../../tests/boundary-exceptions.json):
  its entries, by the id `workspace`.
- [`README.md`](README.md): what it draws, its contracts, its slots, and how to
  build and test it.
- Feature docs: [bundle isolation](../../../docs/features/bundle-isolation.md),
  [thread archive](../../../docs/features/thread-archive.md).
