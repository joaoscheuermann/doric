// The workspace contract the badge reads, as a local copy of the
// `workspace.selection/v1` members it calls (`current`, `subscribe`), so the
// part needs no `workspace` package line. The connection comes from
// `runtime.records/v1`, imported from `runtime/contracts`.

import { type CallArg, type Disposable, ref } from 'bundle/contracts';

/** The selection the workspace shows; the badge reads its Project's id only. */
export interface WorkspaceSelection {
  readonly projectId?: string;
}

/** `workspace.selection/v1` (1.0.0), for the Project's id only. */
export interface WorkspaceSelectionService {
  current(call?: CallArg): WorkspaceSelection;
  subscribe(listener: () => void, call?: CallArg): Disposable;
}

export const WorkspaceSelectionV1 = ref<WorkspaceSelectionService>(
  'workspace.selection/v1',
);
