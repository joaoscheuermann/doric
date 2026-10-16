// The `message` comment kind's flush: how a comment the reader left on one of
// the agent's messages becomes a durable write. The chat owns the kind — it is
// the bundle that turns a text selection in a conversation message into a stack
// item — so it is also the one that says what that item flushes to: one
// `comments/v1.add` with the target the selection recorded and the note the
// reader wrote.
//
// The item's `data` is the shape the selection gesture wrote into the stack:
// `{ target: CommentTarget }`, where the target's `id` is the prompt that
// produced the message and the anchor is the `range` the reader selected.

import type { CommentAddInput, CommentTarget } from 'comments/contracts';

import type { ComposerFlush, ComposerItem } from '../contracts/index.js';
import { MESSAGE_KIND } from '../contracts/index.js';

export { MESSAGE_KIND };

/** Reads the comment target a message item carries, else `undefined`. */
export const messageTargetOf = (data: unknown): CommentTarget | undefined => {
  if (typeof data !== 'object' || data === null) return undefined;
  const target = (data as { target?: unknown }).target;

  if (
    typeof target !== 'object' ||
    target === null ||
    typeof (target as { kind?: unknown }).kind !== 'string' ||
    typeof (target as { id?: unknown }).id !== 'string' ||
    typeof (target as { anchor?: unknown }).anchor !== 'object' ||
    (target as { anchor?: unknown }).anchor === null
  ) {
    return undefined;
  }

  return target as CommentTarget;
};

/**
 * The `message` flush: an item with no note stays drafted (nothing was asked
 * yet), and an item whose data no longer names a message stays drafted too —
 * the sender only writes what the reader actually wrote about.
 */
export const messageFlush: ComposerFlush = (item: ComposerItem) => {
  const note = item.note.trim();
  const target = messageTargetOf(item.data);

  if (note.length === 0 || target === undefined) {
    return Promise.resolve([]);
  }

  const write: CommentAddInput = {
    target,
    text: note,
    ...(item.author === undefined ? {} : { author: item.author }),
  };

  return Promise.resolve([write]);
};
