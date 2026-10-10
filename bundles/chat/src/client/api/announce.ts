// The native notice one live event of a Thread deserves (§7.5): the rule is
// `domain/notifications.ts`; the shown Thread is the window route's, the
// focus the document's, and the notice goes through `doric.notifications/v1`.
// A notice is a courtesy: any failure to show it is swallowed.

import { DoricNotificationsV1, NavigationV1 } from 'bundle/contracts';

import {
  type PromptNotification,
  promptCompletion,
  watchingCompletion,
} from '../domain/notifications.js';
import { routeThread } from '../domain/thread-route.js';
import type { ThreadEvent } from '../domain/workspace.js';
import { chatServices } from '../services/chat-services.js';

export interface AnnounceSources {
  /** The Thread the window shows, when it shows one. */
  readonly shownThreadId: () => string | undefined;
  readonly windowFocused: () => boolean;
  readonly show: (notification: PromptNotification) => Promise<void>;
}

export type Announce = (
  threadId: string,
  threadName: string,
  event: ThreadEvent,
) => void;

export const createAnnounce =
  (sources: AnnounceSources): Announce =>
  (threadId, threadName, event) => {
    const notification = promptCompletion(event, threadName);
    if (notification === undefined) return;
    try {
      // A reader looking at this Thread is reading it, not waiting to be told
      // about it; every other Thread's completion is still announced.
      if (
        watchingCompletion(
          threadId,
          sources.shownThreadId(),
          sources.windowFocused(),
        )
      )
        return;
      void sources.show(notification).catch(() => undefined);
    } catch {
      // A notice is never worth the conversation a throw here would cost.
    }
  };

export const announce: Announce = createAnnounce({
  shownThreadId: () =>
    routeThread(chatServices().use(NavigationV1).current())?.threadId,
  windowFocused: () => document.hasFocus(),
  show: (notification) =>
    chatServices().use(DoricNotificationsV1).show(notification),
});
