// The `papercraft-program` comment kind's flush (D19): how a comment the
// reader left on a papercraft program becomes a durable write. The papercraft
// owns the kind — its client turns a commented click into a stack item — so
// its desktop part says what that item flushes to: one `comments/v1.add` with
// the program target the item's data recorded and the note the reader wrote.
//
// The real `chat.composer/v1.registerFlush` carries a function, so only the
// main process reaches it: this module is imported by `src/desktop/index.ts`
// (desktopMain) and stays free of the DOM, which the desktop runner has none
// of.

import type { ComposerFlush } from '../contracts/chat.js';
import {
  type CommentAddInput,
  type CommentAnchor,
  type CommentTarget,
  PROGRAM_TARGET_KIND,
} from '../contracts/index.js';

const recordOf = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : undefined;

/** The program target an item's `data` names, when it names one. */
const programTargetOf = (data: unknown): CommentTarget | undefined => {
  const target = recordOf(recordOf(data)?.target);

  if (
    target?.kind !== PROGRAM_TARGET_KIND ||
    typeof target.id !== 'string' ||
    target.id === '' ||
    recordOf(target.anchor) === undefined
  ) {
    return undefined;
  }

  return {
    kind: PROGRAM_TARGET_KIND,
    id: target.id,
    ...(typeof target.revision === 'number'
      ? { revision: target.revision }
      : {}),
    anchor: target.anchor as CommentAnchor,
  };
};

/** The root a reply item answers, when its data names one. */
const inReplyToOf = (data: unknown): string | undefined => {
  const value = recordOf(data)?.inReplyTo;

  return typeof value === 'string' && value !== '' ? value : undefined;
};

/**
 * The `papercraft-program` flush (D19): an item with no note stays drafted
 * (nothing was asked yet), and an item whose data names no program target
 * (`{ kind: 'papercraft-program', id: <identity>, revision, anchor }`) stays
 * drafted too. Else one `comments/v1.add` with that target, the note, the
 * item's id as the comment's id — the id the prompt already named, and the one
 * a reply drafted against a root still in the stack points at — and, for a
 * reply, the root it answers. Never rejects.
 */
export const programFlush: ComposerFlush = (item) => {
  const target = programTargetOf(item.data);
  const note = item.note.trim();

  if (note === '' || target === undefined) return Promise.resolve([]);

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
