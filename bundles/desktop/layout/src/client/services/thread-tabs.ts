import type { Ui } from 'bundle/contracts';

import { reconcileThreadTabs } from '../domain/workspace-tabs.js';
import { workspaceStore } from '../stores/workspace.js';
import { workspaceTabsStore } from '../stores/workspace-tabs.js';

/** Keep open thread tabs in step with the activation's confirmed project tree. */
export const watchThreadTabs = (ui: Pick<Ui, 'dispose'>): (() => void) => {
  const reconcile = () => {
    const workspace = workspaceStore.getState();
    const current = workspaceTabsStore.getState().threads;
    const next = Object.fromEntries(
      Object.entries(current).map(([owner, tabs]) => [
        owner,
        reconcileThreadTabs(
          tabs,
          workspace.tree,
          workspace.loadingProjectThreads,
        ),
      ]),
    );
    if (Object.entries(current).every(([owner, tabs]) => next[owner] === tabs))
      return;
    workspaceTabsStore.setState({ threads: next });
    for (const [owner, tabs] of Object.entries(current)) {
      for (const tab of tabs.items) {
        if (
          tab.kind === 'element' &&
          !next[owner]?.items.some((item) => item.id === tab.id)
        )
          ui.dispose(tab.element);
      }
    }
  };
  const stop = workspaceStore.subscribe(reconcile);
  reconcile();
  return stop;
};
