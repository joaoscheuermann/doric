# workspace

These instructions apply to `bundles/desktop/workspace` and narrow
`bundles/AGENTS.md` (once it exists) and the root [`AGENTS.md`](../../../AGENTS.md).

## Function

Choosing what the window shows: Projects, Threads and the selection. Read
[`README.md`](README.md) for what it draws, its contracts and its slots.

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

## Links

- [`manifest.json`](manifest.json): the contracts it provides, requires and
  may use.
- Feature doc: [bundle isolation](../../../docs/features/bundle-isolation.md).
