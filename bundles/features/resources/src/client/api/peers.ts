// The layout contract the monitor reads, as a local copy of the
// `layout.workspace/v1` members it calls: `layout` depends on
// `resources/contracts` (its provisional monitor), so importing
// `layout/contracts` here would make the two projects a build cycle.

import { type CallArg, type Disposable, ref } from 'bundle/contracts';

/** The validated selection the workspace shows (1.1.0). */
export interface WorkspaceSelection {
  readonly project?: { readonly id: string };
}

export interface LayoutWorkspace {
  selection(call?: CallArg): WorkspaceSelection;
  subscribe(listener: () => void, call?: CallArg): Disposable;
}

export const LayoutWorkspaceV1 = ref<LayoutWorkspace>('layout.workspace/v1');
