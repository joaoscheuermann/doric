import { NavigationV1, type Services } from 'bundle/contracts';

import { RuntimeThreadsV1 } from '../api/host.js';
import {
  type ConnectionSource,
  defaultSchedule,
} from '../api/project-watch.js';
import { createThreadViews } from '../api/thread-views.js';
import { threadsOnScreen } from '../domain/thread-views.js';
import { workspaceStore } from '../stores/workspace.js';
import { workspaceTabsStore } from '../stores/workspace-tabs.js';

/**
 * Keeps the window's Thread views on the Threads it shows
 * (docs/designs/thread-archive.md §10.8): a `createThreadViews` over
 * `services.use(RuntimeThreadsV1)`, `connection` and `defaultSchedule`, set to
 * `threadsOnScreen(navigation.current(), selected Project, workspace tabs)`
 * at once and on every change of `navigation/v1`, `workspaceStore` and
 * `workspaceTabsStore`. Bound to the activation services (D9-17); a window
 * counts as showing a Thread whether or not it is focused or minimized.
 *
 * Returns the cleanup: it unsubscribes from the three sources and closes
 * every view. Idempotent.
 */
export const watchThreadViews = (
  services: Services,
  connection: ConnectionSource,
): (() => void) => {
  const navigation = services.use(NavigationV1);
  const views = createThreadViews({
    runtime: services.use(RuntimeThreadsV1),
    connection,
    schedule: defaultSchedule,
  });
  const update = () =>
    views.set(
      threadsOnScreen(
        navigation.current(),
        workspaceStore.getState().tree.selection.projectId,
        workspaceTabsStore.getState().threads,
      ),
    );
  const route = navigation.subscribe(update);
  const stopTree = workspaceStore.subscribe(update);
  const stopTabs = workspaceTabsStore.subscribe(update);
  update();
  let active = true;
  return () => {
    if (!active) return;
    active = false;
    route.dispose();
    stopTree();
    stopTabs();
    views.close();
  };
};
