// The chat's view of `layout.workspace/v1` (D9-9), the sidebar tree the
// layout bundle keeps in the window. The chat reads it through
// `whenAvailable` only, so it keeps a structural copy of the three methods
// instead of importing the layout package; the ID and shapes are the layout's.

import { type CallArg, type Disposable, ref } from 'bundle/contracts';

import type { Thread } from '../domain/workspace.js';

export interface LayoutWorkspace {
  /** The sidebar tree's record of one Thread, when the tree holds it. */
  thread(threadId: string, call?: CallArg): Thread | undefined;
  /** The record of the Thread the window selects, when there is one. */
  selectedThread(call?: CallArg): Thread | undefined;
  /** Called after every change of the tree or of the selection. */
  subscribe(listener: () => void, call?: CallArg): Disposable;
}

export const LayoutWorkspaceV1 = ref<LayoutWorkspace>('layout.workspace/v1');
