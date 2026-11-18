// The chat's view of `workspace.selection/v1`: the Thread the window selects,
// for the footer execution picker. The chat reads it through `whenAvailable`
// only, so it keeps a structural copy instead of importing
// `workspace/contracts`, which a composition without `workspace` would not
// map (bundle isolation 6(c), decision O2); the ids and shapes are
// `workspace`'s.

import { type CallArg, type Disposable, ref } from 'bundle/contracts';

/** A structural copy of `workspace.selection/v1`; the ids and shapes are `workspace`'s. */
export interface WorkspaceSelection {
  readonly projectId?: string;
  readonly threadId?: string;
}

export interface WorkspaceSelectionService {
  /** The same object until the selection changes. */
  current(call?: CallArg): WorkspaceSelection;
  subscribe(listener: () => void, call?: CallArg): Disposable;
}

export const WorkspaceSelectionV1 = ref<WorkspaceSelectionService>(
  'workspace.selection/v1',
);
