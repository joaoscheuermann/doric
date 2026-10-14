// The client contracts the screen part calls, built from their IDs with the
// owner's shape narrowed to what it reads (as `terminal` reaches the
// layout's peers). Importing `layout/contracts` here would close a cycle:
// the layout sits above and screen only reads the selection.

import { type CallArg, type Disposable, ref } from 'bundle/contracts';

/** The fields of a Thread record this part reads. */
export interface ThreadRecord {
  readonly id: string;
  readonly projectId: string;
}

/** The fields of a Project record this part reads (its name labels a view). */
export interface ProjectRecord {
  readonly id: string;
  readonly name?: string;
}

/** The selection the workspace shows; a Project-only selection has no Thread. */
export interface WorkspaceSelection {
  readonly project?: ProjectRecord;
  readonly thread?: ThreadRecord;
}

/** `layout.workspace/v1` (1.1.0), for the selection only. */
export interface LayoutWorkspace {
  selectedThread(call?: CallArg): ThreadRecord | undefined;
  selection(call?: CallArg): WorkspaceSelection;
  subscribe(listener: () => void, call?: CallArg): Disposable;
}

export const LayoutWorkspaceV1 = ref<LayoutWorkspace>('layout.workspace/v1');
