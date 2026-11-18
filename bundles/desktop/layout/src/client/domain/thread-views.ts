// The Threads a window shows, which the window holds a view of through
// `view` of `runtime.records/v1` (docs/designs/thread-archive.md §10.1,
// §10.8). Pure.

import type { RouteMatch } from 'bundle/contracts';

import { routeThread, tabOwnerOf } from './route-selection.js';
import { THREAD_TAB_ICON } from './thread-navigation.js';
import type { WorkspaceTabs } from './workspace-tabs.js';

/**
 * The Threads a window shows: the Thread route's Thread, and the Thread of
 * the tab owner's selected workspace tab when that tab is a Thread tab.
 *
 * - The route's Thread is `routeThread(match)?.threadId`.
 * - The owner is `tabOwnerOf(match, selectedProjectId)`; its tabs are
 *   `tabs[owner]`; the selected tab is the item whose `id` equals their
 *   `selected`. That tab adds `props.threadId` only when it is a Thread tab
 *   (its `iconTag` is `THREAD_TAB_ICON`) and `props.threadId` is a string.
 * - A route that is neither the Thread route nor the Project route has no
 *   owner and answers the route's Thread alone, or nothing.
 *
 * Answers a new set with at most two ids (one when both name the same
 * Thread); an absent owner, tab list, selection or item adds nothing.
 * Never throws and reads nothing but its arguments.
 */
export const threadsOnScreen = (
  match: RouteMatch | undefined,
  selectedProjectId: string | undefined,
  tabs: Readonly<Record<string, WorkspaceTabs>>,
): ReadonlySet<string> => {
  const shown = new Set<string>();
  const routeThreadId = routeThread(match)?.threadId;
  if (routeThreadId !== undefined) shown.add(routeThreadId);
  const owner = tabOwnerOf(match, selectedProjectId);
  const ownerTabs = owner === undefined ? undefined : tabs[owner];
  const tab = ownerTabs?.items.find(({ id }) => id === ownerTabs.selected);
  if (tab?.kind === 'element' && tab.iconTag === THREAD_TAB_ICON) {
    const threadId = tab.props?.threadId;
    if (typeof threadId === 'string') shown.add(threadId);
  }
  return shown;
};
