// layout.workspace/v1 (stage 9, D9-9, §5.7; 1.1.0 WP-10P, R-9.1): the
// sidebar tree's records, the validated selection and the connection for
// other client bundles, backed by the workspace store (a projection of
// `runtime.records/v1`), and the `shell.conversation.bottom` visibility
// requests, which it forwards to the shell's `layout.conversation/v1`.

import { defineMethod, defineService } from 'bundle/contracts';
import { LayoutConversationV1 } from 'layout/contracts';

import {
  LayoutWorkspaceV1,
  type LegacyWorkspaceSelection,
  layoutWorkspaceMethods,
} from '../../contracts/index.js';
import { type ProjectTree, threadsOf } from '../domain/project-tree.js';
import { describedThread } from '../domain/route-selection.js';
import type { Thread } from '../domain/workspace.js';
import { workspaceStore } from '../stores/workspace.js';
import { workspaceServices } from './workspace-services.js';

const selectedThreadOf = (tree: ProjectTree): Thread | undefined => {
  const { projectId, threadId } = tree.selection;
  return threadsOf(tree, projectId).find((thread) => thread.id === threadId);
};

/** The selection `views/workspace-view.tsx` shows: only described records. */
export const selectionOf = (tree: ProjectTree): LegacyWorkspaceSelection => {
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
      execute: () => workspaceStore.getState().connected,
    }),
    setBottomVisible: defineMethod({
      ...layoutWorkspaceMethods.setBottomVisible,
      execute: ([itemId, visible]: [string, boolean]) =>
        workspaceServices()
          .use(LayoutConversationV1)
          .setBottomVisible(itemId, visible),
    }),
    subscribe: defineMethod({
      ...layoutWorkspaceMethods.subscribe,
      execute: (listener: () => void) => {
        const stop = workspaceStore.subscribe(() => listener());
        return { dispose: () => stop() };
      },
    }),
  });
