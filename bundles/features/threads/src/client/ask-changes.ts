// The live changes of the asks open in this window: chat's
// `onThreadUpdateHook` hands every live event of a held Thread to
// `noticeThreadUpdate`, which calls the mounted blocks whose ask the event can
// change, so they read its status again.

import type { ThreadUpdateInput } from './chat-contract.js';
import { rereadsStatus } from './domain/ask.js';

/** The ask a mounted block watches, and the Thread whose events can change it. */
interface AskTarget {
  readonly projectId: string;
  readonly threadId: string;
  readonly askId: string;
  /** The sequence of the ask's `threads.asked/v1` row. */
  readonly sequence: number;
}

interface Watch {
  readonly target: AskTarget;
  readonly listener: () => void;
}

const watches = new Set<Watch>();

/**
 * The `onThreadUpdateHook` handler. For an `event` update it calls, once each,
 * the listeners of the update's Thread whose target `rereadsStatus` for that
 * event. `updated` records and other Threads' events call no one.
 * Never throws: a listener that throws does not stop the others and does not reach chat.
 */
export const noticeThreadUpdate = (input: ThreadUpdateInput): void => {
  if (input.update.kind !== 'event') return;
  const { event } = input.update;
  for (const watch of [...watches]) {
    const { target, listener } = watch;
    try {
      if (
        watches.has(watch) &&
        target.projectId === input.projectId &&
        target.threadId === input.threadId &&
        rereadsStatus(event, target)
      )
        listener();
    } catch (error) {
      console.error('Doric: an ask could not follow a live event:', error);
    }
  }
};

/** Calls `listener` for every live event that can change `target`'s status. Returns the release (idempotent); after it, never called again. */
export const watchAsk = (
  target: AskTarget,
  listener: () => void,
): (() => void) => {
  const watch: Watch = { target, listener };
  watches.add(watch);
  return () => {
    watches.delete(watch);
  };
};
