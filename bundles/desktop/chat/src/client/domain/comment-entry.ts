// The inline comment entry's own vocabulary, stated in terms of its arguments:
// what a key does while the entry is written, and where in the conversation the
// anchor it was opened for sits. The entry stands after the paragraph the
// reader selected, so the seat it writes is the turn and the block of that
// paragraph — the two the stack item carries until the send.

import type { NoteKey, SeatRef } from './composer-stack.js';

/** What one key pressed in the comment entry does. */
export type CommentKeyAction =
  /** Commits the note and closes the entry. */
  | 'send'
  /** Writes a newline, the way the browser's own Shift+Enter does. */
  | 'newline'
  /** The browser's own editing of the field. */
  | 'default';

/** Where the entry stands when the key is pressed. */
export interface CommentEntryState {
  /** Whether the entry holds no text. */
  readonly empty: boolean;
  /** Whether an input method is composing the words being written. */
  readonly composing: boolean;
}

/**
 * What a key does in the comment entry. Enter commits the note once the entry
 * holds words and no composition is in progress; Shift+Enter writes a newline
 * and keeps the entry open; every other key, and Enter while the entry is
 * empty or an input method is composing, is the field's own.
 */
export const commentKeyAction = (
  key: Pick<NoteKey, 'key' | 'shift'>,
  at: CommentEntryState,
): CommentKeyAction => {
  if (key.key !== 'Enter') return 'default';
  if (key.shift) return 'newline';
  if (at.empty || at.composing) return 'default';

  return 'send';
};

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : undefined;

/**
 * The turn and block an anchor names, else `undefined`: a seat needs a turn
 * with words of its own and a 0-based block, and an anchor that names neither
 * — every comment written before the field existed — has no seat to open.
 */
export const seatOfAnchor = (anchor: unknown): SeatRef | undefined => {
  const record = asRecord(anchor);
  const turn = record?.turn;
  const block = record?.block;

  if (typeof turn !== 'string' || turn.length === 0) return undefined;
  if (typeof block !== 'number' || !Number.isInteger(block) || block < 0) {
    return undefined;
  }

  return { turn, block };
};
