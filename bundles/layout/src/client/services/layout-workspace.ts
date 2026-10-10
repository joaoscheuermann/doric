// layout.workspace/v1 (stage 9, D9-9, §5.7): the sidebar tree's records for
// other client bundles, backed by the workspace store.

import { defineMethod, defineService } from 'bundle/contracts';

import {
  LayoutWorkspaceV1,
  layoutWorkspaceMethods,
} from '../../contracts/index.js';
import { threadsOf } from '../domain/project-tree.js';
import { describedThread } from '../domain/route-selection.js';
import { workspaceStore } from '../stores/workspace.js';

export const createLayoutWorkspace = () =>
  defineService(LayoutWorkspaceV1, {
    thread: defineMethod({
      ...layoutWorkspaceMethods.thread,
      execute: (threadId: string) =>
        describedThread(workspaceStore.getState().tree, threadId),
    }),
    selectedThread: defineMethod({
      ...layoutWorkspaceMethods.selectedThread,
      execute: () => {
        const { tree } = workspaceStore.getState();
        const { projectId, threadId } = tree.selection;
        return threadsOf(tree, projectId).find(
          (thread) => thread.id === threadId,
        );
      },
    }),
    subscribe: defineMethod({
      ...layoutWorkspaceMethods.subscribe,
      execute: (listener: () => void) => {
        const unsubscribe = workspaceStore.subscribe(() => listener());
        let active = true;
        return {
          dispose: () => {
            if (!active) return;
            active = false;
            unsubscribe();
          },
        };
      },
    }),
  });
