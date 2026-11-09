// The layout contract the badge reads, as a local copy of the
// `layout.workspace/v1` members it calls (`selection`, `connected`,
// `subscribe`): `layout` depends on `resources/contracts`, so importing
// `layout/contracts` here would make the two projects a build cycle.

import { type CallArg, type Disposable, ref } from 'bundle/contracts';

/** The validated selection the workspace shows (1.1.0). */
export interface WorkspaceSelection {
  readonly project?: { readonly id: string };
}

export interface LayoutWorkspace {
  selection(call?: CallArg): WorkspaceSelection;
  /**
   * 1.1.0: whether the window is connected to the host. A change in the
   * connection notifies `subscribe`'s listeners. It matches
   * `bundles/desktop/layout/src/contracts/index.ts:117-118`.
   */
  connected(call?: CallArg): boolean;
  subscribe(listener: () => void, call?: CallArg): Disposable;
}

export const LayoutWorkspaceV1 = ref<LayoutWorkspace>('layout.workspace/v1');
