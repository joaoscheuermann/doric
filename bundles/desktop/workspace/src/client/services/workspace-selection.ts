// workspace.selection/v1 (bundle isolation 4(c), spec §6): the validated
// selection the workspace shows, as ids, for other client bundles.

import { defineMethod, defineService } from 'bundle/contracts';

import {
  type WorkspaceSelection,
  WorkspaceSelectionV1,
  workspaceSelectionMethods,
} from '../../contracts/index.js';
import { workspaceStore } from '../stores/workspace.js';
import { selectionOf } from './workspace-workspace.js';

export const createWorkspaceSelection = () => {
  let last: WorkspaceSelection = {};
  /** The ids of the described selection; the same object until either id changes. */
  const current = (): WorkspaceSelection => {
    const { project, thread } = selectionOf(workspaceStore.getState().tree);
    if (project?.id === last.projectId && thread?.id === last.threadId)
      return last;
    last = {
      ...(project === undefined ? {} : { projectId: project.id }),
      ...(thread === undefined ? {} : { threadId: thread.id }),
    };
    return last;
  };

  return defineService(WorkspaceSelectionV1, {
    current: defineMethod({
      ...workspaceSelectionMethods.current,
      execute: current,
    }),
    subscribe: defineMethod({
      ...workspaceSelectionMethods.subscribe,
      execute: (listener: () => void) => {
        let seen = current();
        const stop = workspaceStore.subscribe(() => {
          const next = current();
          if (next === seen) return;
          seen = next;
          listener();
        });
        return { dispose: () => stop() };
      },
    }),
  });
};
