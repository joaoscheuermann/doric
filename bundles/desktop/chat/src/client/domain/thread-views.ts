// The Threads a window shows, which the window holds a view of through
// `view` of `runtime.records/v1` (docs/designs/thread-archive.md §10.1,
// §10.8; bundle isolation 4(c), D33). Pure.

import type { RouteMatch } from 'bundle/contracts';
import type { CurrentTab } from 'layout/contracts';

import { routeThread } from './thread-route.js';

/**
 * The Threads this window shows: the Thread of the Thread route, and the
 * Thread of the selected viewer tab when the chat opened that tab.
 *
 * - The route's Thread is `routeThread(match)?.threadId`.
 * - `tab` is what `layout.tabs/v2.current()` answers, the selected tab of the
 *   active owner. It adds its `props.threadId` when that is a string and the
 *   tab's `id` is `thread:` followed by it, the id the chat gives the tabs it
 *   opens.
 *
 * Answers a new set with at most two ids (one when both name the same
 * Thread). Never throws and reads nothing but its arguments.
 */
export const threadsOnScreen = (
  match: RouteMatch | undefined,
  tab: CurrentTab | undefined,
): ReadonlySet<string> => {
  const shown = new Set<string>();
  const routeThreadId = routeThread(match)?.threadId;
  if (routeThreadId !== undefined) shown.add(routeThreadId);
  const threadId = tab?.props?.threadId;
  if (typeof threadId === 'string' && tab?.id === `thread:${threadId}`)
    shown.add(threadId);
  return shown;
};
