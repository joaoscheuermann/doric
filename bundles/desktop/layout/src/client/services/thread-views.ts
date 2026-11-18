import { type Disposable, NavigationV1, type Services } from 'bundle/contracts';

import { threadsOnScreen } from '../domain/thread-views.js';
import { RecordsV1 } from '../domain/workspace.js';
import { workspaceStore } from '../stores/workspace.js';
import { workspaceTabsStore } from '../stores/workspace-tabs.js';

/**
 * Keeps the window's Thread views on the Threads it shows
 * (docs/designs/thread-archive.md §10.8): one `view` of `runtime.records/v1`
 * per Thread of `threadsOnScreen(navigation.current(), selected Project,
 * workspace tabs)`, at once and on every change of `navigation/v1`,
 * `workspaceStore` and `workspaceTabsStore`. On each change the new views are
 * taken before the previous ones are disposed, so a Thread on screen before
 * and after keeps a view. The mirror is reached through `whenAvailable`
 * alone: without a provider no view is held. Bound to the activation
 * services (D9-17); a window counts as showing a Thread whether or not it is
 * focused or minimized.
 *
 * Returns the cleanup: it unsubscribes from the three sources and disposes
 * every view. Idempotent.
 */
export const watchThreadViews = (services: Services): (() => void) => {
  const navigation = services.use(NavigationV1);
  const available = services.whenAvailable(RecordsV1, (records) => {
    let held: ReadonlyMap<string, Disposable> = new Map();
    const update = () => {
      const shown = threadsOnScreen(
        navigation.current(),
        workspaceStore.getState().tree.selection.projectId,
        workspaceTabsStore.getState().threads,
      );
      // A change that shows the same Threads keeps the views it holds.
      if (
        shown.size === held.size &&
        [...shown].every((threadId) => held.has(threadId))
      )
        return;
      const previous = held;
      held = new Map(
        [...shown].map((threadId) => [threadId, records.view({ threadId })]),
      );
      for (const view of previous.values()) view.dispose();
    };
    const route = navigation.subscribe(update);
    const stopTree = workspaceStore.subscribe(update);
    const stopTabs = workspaceTabsStore.subscribe(update);
    update();
    return () => {
      route.dispose();
      stopTree();
      stopTabs();
      for (const view of held.values()) view.dispose();
      held = new Map();
    };
  });
  let active = true;
  return () => {
    if (!active) return;
    active = false;
    available.dispose();
  };
};
