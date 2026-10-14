// The client contracts the screen part calls, built from their IDs with the
// owner's shape narrowed to what it reads (as `terminal` reaches the
// layout's peers). Importing `layout/contracts` here would close a cycle:
// the layout sits above and screen only reads the selected Thread.

import { type CallArg, type Disposable, ref } from 'bundle/contracts';

/** The fields of a Thread record this part reads. */
export interface ThreadRecord {
  readonly id: string;
  readonly projectId: string;
}

/** `layout.workspace/v1` (1.1.0), for the selected Thread only. */
export interface LayoutWorkspace {
  selectedThread(call?: CallArg): ThreadRecord | undefined;
  subscribe(listener: () => void, call?: CallArg): Disposable;
}

export const LayoutWorkspaceV1 = ref<LayoutWorkspace>('layout.workspace/v1');
