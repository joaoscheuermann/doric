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
  PROGRAM_TARGET_KIND,
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
export const papercraftFlush: ComposerFlush = (item) =>
  Promise.resolve(writesOf(item, previewItemTargetOf(item.data)));

/** The one write of an item with a note and a target; none otherwise. */
const writesOf = (
  item: Parameters<ComposerFlush>[0],
  target: CommentAddInput['target'] | undefined,
): CommentAddInput[] => {
  const note = item.note.trim();

  if (note === '' || target === undefined) return [];

  const inReplyTo = inReplyToOf(item.data);

  return [
    {
      target,
      text: note,
      commentId: item.id,
      ...(inReplyTo === undefined ? {} : { inReplyTo }),
      ...(item.author === undefined ? {} : { author: item.author }),
    },
  ];
};

/**
 * The `papercraft-program` flush (D19): `papercraftFlush`'s rules for an item
 * whose `data` records a program target (`{ kind: 'papercraft-program', id:
 * <identity>, revision, anchor }`) — no note or no target, no write; else one
 * `comments/v1.add` with that target, the note, the item's id as the comment's
 * id and, for a reply, the root it answers. Never rejects.
 */
export const programFlush: ComposerFlush = (item) => {
  const target = previewItemTargetOf(item.data);

  return Promise.resolve(
    writesOf(item, target?.kind === PROGRAM_TARGET_KIND ? target : undefined),
  );
};
