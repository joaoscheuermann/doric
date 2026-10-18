import type { RefObject } from 'react';

import { LayoutTabsV1 } from '../../contracts/index.js';
import { isDescribed, type Selection } from '../domain/project-tree.js';
import { mainThreadFor } from '../domain/thread-navigation.js';
import type { Thread } from '../domain/workspace.js';
import { layoutServices } from '../services/layout-services.js';
import { rewriteRoute } from '../stores/route-selection.js';
import { workspaceStore } from '../stores/workspace.js';

/** Resolves a child into the right-hand tabs while keeping a root conversation. */
export function createThreadNavigation({
  intent,
  loadThreads,
  userSelection,
}: {
  readonly intent: RefObject<number>;
  readonly loadThreads: (projectId: string) => Promise<void>;
  readonly userSelection: (selection: Selection) => void;
}) {
  return async (
    target: Thread,
    user: boolean,
  ): Promise<Selection | undefined> => {
    const requestIntent = intent.current;
    const store = workspaceStore.getState();
    let described = isDescribed(store.tree, target.projectId);
    if (
      !store.tree.threadsByProject[target.projectId]?.some(
        (thread) => thread.id === target.id,
      )
    )
      store.applyThread(target);
    let main = mainThreadFor(store.tree, target);
    if (main === undefined) {
      await loadThreads(target.projectId);
      if (intent.current !== requestIntent) return undefined;
      described = true;
      main = mainThreadFor(workspaceStore.getState().tree, target);
    }
    if (main === undefined) {
      store.report('The parent thread was not found.');
      return undefined;
    }
    const selection = { projectId: main.projectId, threadId: main.id };
    if (user) userSelection(selection);
    store.selectThread(main);
    if (target.parentThreadId !== undefined) {
      // The tab service takes ownership from the route. Canonicalize it before
      // opening, so a direct child link cannot own a second set of tabs.
      rewriteRoute(selection);
      try {
        await layoutServices()
          .use(LayoutTabsV1)
          .open({
            id: `thread:${target.id}`,
            title: target.name || 'Untitled',
            tag: 'chat-thread-panel',
            props: { projectId: target.projectId, threadId: target.id },
            icon: 'thread',
          });
      } catch (reason) {
        store.fail(reason);
      }
    }
    if (intent.current !== requestIntent) return undefined;
    if (!described) void loadThreads(main.projectId);
    return selection;
  };
}
