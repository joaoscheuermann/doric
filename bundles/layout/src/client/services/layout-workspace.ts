// layout.workspace/v1 (stage 9, D9-9, §5.7; 1.1.0 WP-10P, R-9.1): the
// sidebar tree's records, the validated selection and the connection for
// other client bundles, backed by the workspace and connection stores, and
// the `layout.main.bottom` visibility requests.

import { defineMethod, defineService } from 'bundle/contracts';

import {
  LayoutWorkspaceV1,
  layoutWorkspaceMethods,
  type WorkspaceSelection,
} from '../../contracts/index.js';
import { type ProjectTree, threadsOf } from '../domain/project-tree.js';
import { describedThread } from '../domain/route-selection.js';
import type { Thread } from '../domain/workspace.js';
import { bottomStore } from '../stores/bottom.js';
import { connectionStore } from '../stores/connection.js';
import { workspaceStore } from '../stores/workspace.js';
import { watchAll } from './subscription.js';

const selectedThreadOf = (tree: ProjectTree): Thread | undefined => {
  const { projectId, threadId } = tree.selection;
  return threadsOf(tree, projectId).find((thread) => thread.id === threadId);
};

/** The selection `views/workspace-view.tsx` shows: only described records. */
export const selectionOf = (tree: ProjectTree): WorkspaceSelection => {
  const project = tree.projects.find(
    (candidate) => candidate.id === tree.selection.projectId,
  );
  const thread = selectedThreadOf(tree);
  return {
    ...(project === undefined ? {} : { project }),
    ...(thread === undefined ? {} : { thread }),
  };
};

export const createLayoutWorkspace = () =>
  defineService(LayoutWorkspaceV1, {
    thread: defineMethod({
      ...layoutWorkspaceMethods.thread,
      execute: (threadId: string) =>
        describedThread(workspaceStore.getState().tree, threadId),
    }),
    selectedThread: defineMethod({
      ...layoutWorkspaceMethods.selectedThread,
      execute: () => selectedThreadOf(workspaceStore.getState().tree),
    }),
    selection: defineMethod({
      ...layoutWorkspaceMethods.selection,
      execute: () => selectionOf(workspaceStore.getState().tree),
    }),
    threads: defineMethod({
      ...layoutWorkspaceMethods.threads,
      execute: (projectId: string) =>
        threadsOf(workspaceStore.getState().tree, projectId),
    }),
    connected: defineMethod({
      ...layoutWorkspaceMethods.connected,
      execute: () => connectionStore().getState().status === 'connected',
    }),
    setBottomVisible: defineMethod({
      ...layoutWorkspaceMethods.setBottomVisible,
      execute: ([itemId, visible]: [string, boolean]) =>
        bottomStore.getState().set(itemId, visible),
    }),
    subscribe: defineMethod({
      ...layoutWorkspaceMethods.subscribe,
      execute: (listener: () => void) =>
        watchAll(listener, [
          (notify) => workspaceStore.subscribe(notify),
          (notify) => connectionStore().subscribe(notify),
        ]),
    }),
  });
