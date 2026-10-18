// The window's side of notifications: a pure observer of chat's live Thread
// updates. It samples the shown Thread and the focus at receive time and
// reports every live event; the decision happens in desktopMain.

import { defineHook, defineHooks } from 'bundle/contracts';
import { z } from 'zod';

import type { PromptObservation, ThreadEvent } from '../contracts/index.js';

/**
 * A structural copy of the one chat hook this bundle registers. Hooks are
 * matched by contract ID only, so this avoids importing `chat/contracts`,
 * which a composition without chat would not map.
 */
export const ChatHooksV1 = defineHooks('chat.hooks/v1', {
  onThreadUpdateHook: defineHook({
    kind: 'observe',
    input: z.object({
      projectId: z.string(),
      threadId: z.string(),
      threadName: z.string(),
      update: z.custom<
        | { readonly kind: 'event'; readonly event: ThreadEvent }
        | { readonly kind: 'updated'; readonly thread: unknown }
      >(
        (value) =>
          typeof value === 'object' &&
          value !== null &&
          ((value as { kind?: unknown }).kind === 'event' ||
            (value as { kind?: unknown }).kind === 'updated'),
      ),
    }),
  }),
});

export type ThreadUpdateInput = z.output<
  (typeof ChatHooksV1)['hooks']['onThreadUpdateHook']['input']
>;

export interface ObserverSources {
  /** The Thread the window's route shows, when it names one. */
  readonly shownThreadId: () => string | undefined;
  readonly windowFocused: () => boolean;
  readonly report: (observation: PromptObservation) => Promise<void>;
}

/** The `onThreadUpdateHook` handler: reports each live event, never awaited. */
export const createObserver =
  (sources: ObserverSources) =>
  (input: ThreadUpdateInput): void => {
    if (input.update.kind !== 'event') return;
    try {
      const shownThreadId = sources.shownThreadId();
      void sources
        .report({
          threadId: input.threadId,
          threadName: input.threadName,
          event: input.update.event,
          ...(shownThreadId === undefined ? {} : { shownThreadId }),
          windowFocused: sources.windowFocused(),
        })
        .catch(() => undefined);
    } catch {
      // A notice is never worth the conversation a throw here would cost.
    }
  };
