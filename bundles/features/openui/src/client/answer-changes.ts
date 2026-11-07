// The live changes of the questions open in this window (conversation-openui.md
// D21): chat's `onThreadUpdateHook` hands every live event of a held Thread to
// `noticeThreadUpdate`, which calls the mounted question forms whose answer
// the event can change, so they read their status again.

import type { ChatThreadEvent, ThreadUpdateInput } from './chat-contract.js';
import type { AnswerTarget, WatchAnswers } from './chunks/renderer.js';

/** The row a rewind writes, which can remove an answered row. */
const TRUNCATED = 'history.truncated';

/** The answered event's type (`openui.answered/v1`). */
const ANSWERED = 'openui.answered/v1';

/**
 * Whether a live event can change `target`'s answer: an event of the target's
 * Project and Thread that is an `openui.answered/v1` row whose
 * `questionPromptId` is `target.promptId`, or a `history.truncated` row.
 * Never throws.
 */
export const rereadsAnswer = (
  event: ChatThreadEvent,
  target: AnswerTarget,
): boolean => {
  if (
    event.projectId !== target.projectId ||
    event.threadId !== target.threadId
  ) {
    return false;
  }
  if (event.type === TRUNCATED) return true;
  if (event.type !== ANSWERED) return false;
  const row = event.event;
  return (
    typeof row === 'object' &&
    row !== null &&
    'questionPromptId' in row &&
    row.questionPromptId === target.promptId
  );
};

interface Watch {
  readonly target: AnswerTarget;
  readonly listener: () => void;
}

const watches = new Set<Watch>();

/**
 * The `onThreadUpdateHook` handler. For an `event` update it calls, once each,
 * the listeners of the update's Thread whose target `rereadsAnswer` accepts
 * for that event. `updated` records and other Threads' events call no one.
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
        rereadsAnswer(event, target)
      )
        listener();
    } catch (error) {
      console.error('Doric: a question could not follow a live event:', error);
    }
  }
};

/** Calls `listener` for every live event that can change `target`'s answer. Returns the release (idempotent); after it, never called again. */
export const watchAnswers: WatchAnswers = (target, listener) => {
  const watch: Watch = { target, listener };
  watches.add(watch);
  return () => {
    watches.delete(watch);
  };
};
