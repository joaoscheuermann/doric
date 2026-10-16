// The `papercraft-preview` comment kind's flush: how a comment the reader left
// on a preview becomes a durable write. The papercraft owns the kind — its
// client turns a commented click into a stack item — so its desktop part says
// what that item flushes to: one `comments/v1.add` with the `artifact` target
// the item's data recorded and the note the reader wrote.
//
// The real `chat.composer/v1.registerFlush` carries a function, so only the
// main process reaches it: this module is imported by `src/desktop/index.ts`
// (desktopMain) and stays free of the DOM, which the desktop runner has none of
// (it is why the target is read with the contracts' `previewItemTargetOf`
// rather than the client's DOM-bound `src/client/anchor.ts`). A draft written
// before the item carried its `target` still flushes from the `artifactId`,
// `revision` and `anchor` it recorded.

import type { ComposerFlush } from '../contracts/chat.js';
import {
  type CommentAddInput,
  previewItemTargetOf,
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
 * The `papercraft-preview` flush: an item with no note stays drafted (nothing
 * was asked yet), and an item whose data no longer names a target stays drafted
 * too — the sender only writes what the reader actually wrote about. The write
 * carries the item's id as the comment's id — the id the prompt already named,
 * and the one a reply drafted against a root still in the stack points at —
 * and, for a reply, the root it answers. The composer service hands the writes
 * to the sender, which performs the `comments/v1.add`.
 */
export const papercraftFlush: ComposerFlush = (item) => {
  const note = item.note.trim();
  const target = previewItemTargetOf(item.data);

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
