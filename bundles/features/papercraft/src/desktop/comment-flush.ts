// The `papercraft-preview` comment kind's flush: how a comment the reader left
// on a preview becomes a durable write. The papercraft owns the kind — its
// client turns a commented click into a stack item — so its desktop part says
// what that item flushes to: one `comments/v1.add` with the `artifact` target
// the item's data recorded and the note the reader wrote.
//
// The real `chat.composer/v1.registerFlush` carries a function, so only the
// main process reaches it: this module is imported by `src/desktop/index.ts`
// (desktopMain) and stays free of the DOM, which the desktop runner has none of
// (it is why the target is remade here rather than imported from the client's
// DOM-bound `src/client/anchor.ts`).

import type { ComposerFlush, ComposerItem } from '../client/chat-contract.js';
import {
  ARTIFACT_TARGET_KIND,
  type CommentAddInput,
  type CommentAnchor,
  type CommentTarget,
} from '../contracts/index.js';

/**
 * The target a papercraft item's `data` recorded, else `undefined`: the client
 * wrote the artifact, the revision and the anchor — the same fields
 * `src/client/anchor.ts#targetOf` shapes into the `artifact` target.
 */
const commentTargetOf = (item: ComposerItem): CommentTarget | undefined => {
  if (typeof item.data !== 'object' || item.data === null) return undefined;

  const data = item.data as {
    readonly artifactId?: unknown;
    readonly revision?: unknown;
    readonly anchor?: unknown;
  };

  if (
    typeof data.artifactId !== 'string' ||
    data.artifactId === '' ||
    typeof data.revision !== 'number' ||
    typeof data.anchor !== 'object' ||
    data.anchor === null
  ) {
    return undefined;
  }

  return {
    kind: ARTIFACT_TARGET_KIND,
    id: data.artifactId,
    revision: data.revision,
    anchor: data.anchor as CommentAnchor,
  };
};

/**
 * The `papercraft-preview` flush: an item with no note stays drafted (nothing
 * was asked yet), and an item whose data no longer names a target stays drafted
 * too — the sender only writes what the reader actually wrote about. It answers
 * the writes; the composer service hands them to the sender, which performs the
 * `comments/v1.add`.
 */
export const papercraftFlush: ComposerFlush = (item) => {
  const note = item.note.trim();
  const target = commentTargetOf(item);

  if (note === '' || target === undefined) {
    return Promise.resolve([]);
  }

  const write: CommentAddInput = {
    target,
    text: note,
    ...(item.author === undefined ? {} : { author: item.author }),
  };

  return Promise.resolve([write]);
};
