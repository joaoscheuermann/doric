import { errorFrom } from 'desktop/reads';
import type { RefObject } from 'react';

import { LayoutTabsV2 } from '../../contracts/index.js';
import {
  isDescribed,
  type Selection,
  threadsOf,
} from '../domain/project-tree.js';
import {
  mainThreadFor,
  THREAD_PANEL_TAG,
  THREAD_TAB_ICON,
} from '../domain/thread-navigation.js';
import type { Thread } from '../domain/workspace.js';
import { layoutServices } from '../services/layout-services.js';
import { rewriteRoute } from '../stores/route-selection.js';
import { boundRecords, workspaceStore } from '../stores/workspace.js';

/**
 * Opens `thread` in a viewer tab of the active owner, as a sub-thread opens
 * (P18), and selects the tab; the conversation column keeps what it shows. A
 * refusal is reported in the sidebar.
 */
export const openThreadTab = async (thread: Thread): Promise<void> => {
  try {
    await layoutServices()
      .use(LayoutTabsV2)
      .open({
        id: `thread:${thread.id}`,
        title: thread.name || 'Untitled',
        tag: THREAD_PANEL_TAG,
        props: { projectId: thread.projectId, threadId: thread.id },
        iconTag: THREAD_TAB_ICON,
        openBottom: true,
      });
  } catch (reason) {
    workspaceStore.getState().fail(reason);
  }
};

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
    // A fetched Thread of a Project not described yet: reading that Project's
    // Threads starts the mirror's load. A described Project that does not hold
    // it: the mirror reloads that Project's Threads. Either way the record
    // reaches the tree when the load settles.
    if (!described) store.request(target.projectId);
    else if (
      !threadsOf(store.tree, target.projectId).some(
        (row) => row.id === target.id,
      )
    ) {
      boundRecords()?.reload({
        target: 'threads',
        projectId: target.projectId,
      });
    }
    let main = mainThreadFor(store.tree, target);
    if (main === undefined) {
      await loadThreads(target.projectId);
      if (intent.current !== requestIntent) return undefined;
      described = true;
      main = mainThreadFor(workspaceStore.getState().tree, target);
    }
    if (main === undefined) {
      store.report(errorFrom('not_found', 'The parent thread was not found.'));
      return undefined;
    }
    const selection = { projectId: main.projectId, threadId: main.id };
    if (user) userSelection(selection);
    store.selectThread(main);
    if (target.parentThreadId !== undefined) {
      // The tab service takes ownership from the route. Canonicalize it before
      // opening, so a direct child link cannot own a second set of tabs.
      rewriteRoute(selection);
      await openThreadTab(target);
    }
    if (intent.current !== requestIntent) return undefined;
    if (!described) void loadThreads(main.projectId);
    return selection;
  };
}
