// The window's selection as the files client reads it: the selected ids of
// `workspace.selection/v1` and their records in `runtime.records/v1`. One
// adapter for the reveal command, the tree and the refresh coordinator.

import type { Disposable } from 'bundle/contracts';
import type { Project, RuntimeRecords, Thread } from 'runtime/contracts';
import type { WorkspaceSelectionService } from 'workspace/contracts';

import type { RefreshWorkspace } from '../refresh/coordinator.js';

/** The records of the selected Project and Thread, while the records hold them. */
export interface FilesSelection {
  readonly project?: Project;
  readonly thread?: Thread;
}

/** The Project and Thread records of the selection. */
export const selectionOf = (
  selection: WorkspaceSelectionService,
  records: RuntimeRecords,
): FilesSelection => {
  const { projectId, threadId } = selection.current();
  const project =
    projectId === undefined ? undefined : records.project(projectId);
  const thread = threadId === undefined ? undefined : records.thread(threadId);
  return {
    ...(project === undefined ? {} : { project }),
    ...(thread === undefined ? {} : { thread }),
  };
};

/**
 * The workspace the refresh coordinator listens to: the selection's records,
 * the records' Threads of a Project (none while their read is not ready), the
 * records' connection, and both contracts' notifications.
 */
export const refreshWorkspaceOf = (
  selection: WorkspaceSelectionService,
  records: RuntimeRecords,
): RefreshWorkspace => ({
  selection: () => selectionOf(selection, records),
  threads: (projectId) => {
    const read = records.threads(projectId);
    return read.status === 'ready' ? read.value : [];
  },
  connected: () => records.connection() === 'connected',
  subscribe: (listener): Disposable => {
    const subscriptions = [
      selection.subscribe(listener),
      records.subscribe(listener),
    ];
    return {
      dispose: () => {
        for (const subscription of subscriptions) subscription.dispose();
      },
    };
  },
});
