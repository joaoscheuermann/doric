// The `drawio-diagram` comment kind's flush: how a comment the reader left on
// a diagram becomes a durable write. Imported by `src/desktop/index.ts`
// (desktopMain) and free of the DOM: it reads the target with the contracts'
// `diagramItemTargetOf`.

import type { ComposerFlush } from '../contracts/chat.js';
import {
  type CommentAddInput,
  diagramItemTargetOf,
} from '../contracts/index.js';

/** The root a reply item answers, when its data names one. */
const inReplyToOf = (data: unknown): string | undefined => {
  const value =
    typeof data === 'object' && data !== null
      ? (data as { readonly inReplyTo?: unknown }).inReplyTo
      : undefined;

  return typeof value === 'string' && value !== '' ? value : undefined;
};

/**
 * The `drawio-diagram` flush. Answers `[]` (the item stays drafted) when the
 * note is empty after `trim` or `diagramItemTargetOf(item.data)` is
 * undefined. Otherwise answers exactly one write:
 * `{ target, text: <trimmed note>, commentId: item.id }`, plus `inReplyTo`
 * when `data.inReplyTo` is a non-empty string, plus `author` when the item
 * has one. Never rejects; ignores `context`.
 */
export const drawioFlush: ComposerFlush = (item) => {
  const note = item.note.trim();
  const target = diagramItemTargetOf(item.data);

  if (note === '' || target === undefined) {
    return Promise.resolve([]);
  }

  const inReplyTo = inReplyToOf(item.data);
  const write: CommentAddInput = {
    target,
    text: note,
    commentId: item.id,
    ...(inReplyTo === undefined ? {} : { inReplyTo }),
    ...(item.author === undefined ? {} : { author: item.author }),
  };

  return Promise.resolve([write]);
};
