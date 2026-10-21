// The comments the reader opened in one conversation's editor and has not let
// go of: typing over a selection claims the seat it opens, and the comment
// releases it when it is removed. A claimed seat is wanted even before its
// comment reaches the stack (`plugins/comment-seats.tsx`), so a seat the reader
// is writing in — or one whose first add is still out — is never taken for a
// stale one.
//
// A claim also holds the words typed over the selection to open the comment,
// which the note takes (`takeTyped`) as it mounts, with the caret after them.
//
// Claims belong to the editor that drew them, so a remounted conversation (a
// new editor) starts with none and seats only what the stack holds.

import type { LexicalEditor } from 'lexical';

import type { SeatWant } from '../../../../domain/comment-seats.js';

/** A claimed seat, and the words that opened it until its note takes them. */
interface Claim {
  readonly seat: SeatWant;
  typed: string | undefined;
}

const claims = new WeakMap<LexicalEditor, Map<string, Claim>>();

/** Claims the seat a new comment opens, with what was typed to open it. */
export const claimSeat = (
  editor: LexicalEditor,
  seat: SeatWant,
  typed: string,
): void => {
  const held = claims.get(editor) ?? new Map<string, Claim>();
  held.set(seat.id, { seat, typed });
  claims.set(editor, held);
};

/** Lets a removed comment's seat go. */
export const releaseSeat = (editor: LexicalEditor, id: string): void => {
  claims.get(editor)?.delete(id);
};

/** The seats the editor's reader holds. */
export const claimedSeats = (editor: LexicalEditor): SeatWant[] =>
  [...(claims.get(editor)?.values() ?? [])].map((claim) => claim.seat);

/** The words that opened a seat, once: the note's own as it mounts. */
export const takeTyped = (
  editor: LexicalEditor,
  id: string,
): string | undefined => {
  const claim = claims.get(editor)?.get(id);
  const typed = claim?.typed;
  if (claim !== undefined) claim.typed = undefined;
  return typed;
};
