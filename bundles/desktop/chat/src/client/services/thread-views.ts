import { type Disposable, NavigationV1, type Services } from 'bundle/contracts';
import { LayoutTabsV2 } from 'layout/contracts';
import { RuntimeRecordsV1 } from 'runtime/contracts';

import { threadsOnScreen } from '../domain/thread-views.js';

/**
 * Keeps the window's Thread views on the Threads it shows
 * (docs/designs/thread-archive.md §10.8; bundle isolation 4(c)): one `view`
 * of `runtime.records/v1` per Thread of
 * `threadsOnScreen(navigation.current(), tabs.current())`, at once and on
 * every change of `navigation/v1`, `layout.tabs/v2` and the mirror. On each
 * change the new views are taken before the previous ones are disposed, so a
 * Thread on screen before and after keeps its stream, and a view whose stream
 * ended is taken again. The mirror is reached through `whenAvailable` alone:
 * without a provider no view is held. Bound to the activation services
 * (D9-17).
 *
 * Returns the cleanup: it unsubscribes from the three sources and disposes
 * every view. Idempotent.
 */
export const watchThreadViews = (services: Services): (() => void) => {
  const navigation = services.use(NavigationV1);
  const tabs = services.use(LayoutTabsV2);
  const available = services.whenAvailable(RuntimeRecordsV1, (records) => {
    let held: readonly Disposable[] = [];
    const update = () => {
      const previous = held;
      held = [...threadsOnScreen(navigation.current(), tabs.current())].map(
        (threadId) => records.view({ threadId }),
      );
      for (const view of previous) view.dispose();
    };
    const route = navigation.subscribe(update);
    const tabChanges = tabs.subscribe(update);
    const recordChanges = records.subscribe(update);
    update();
    return () => {
      route.dispose();
      tabChanges.dispose();
      recordChanges.dispose();
      for (const view of held) view.dispose();
      held = [];
    };
  });
  let active = true;
  return () => {
    if (!active) return;
    active = false;
    available.dispose();
  };
};
