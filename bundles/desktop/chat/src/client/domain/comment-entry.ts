// The inline comment entry's own vocabulary, stated in terms of its arguments:
// what a key does while the comment is written or edited, and whether its note
// holds words — which decides whether it reaches the stack and whether it
// outlives the focus leaving it.

import type { NoteKey } from './composer-stack.js';

/** What one key pressed in the comment entry does. */
export type CommentKeyAction =
  /** Commits the note and hands the caret to the prompt; the comment stays. */
  | 'commit'
  /** Writes a newline, the way the browser's own Shift+Enter does. */
  | 'newline'
  /** Removes the comment: its stack item, its highlight and its seat. */
  | 'remove'
  /** The browser's own editing of the note. */
  | 'default';

/** Where the entry stands when the key is pressed. */
export interface CommentEntryState {
  /** Whether the note holds no words (`hasWords`). */
  readonly empty: boolean;
  /** Whether an input method is composing the words being written. */
  readonly composing: boolean;
}

/**
 * What a key does in the comment entry, while it is written or edited. Escape
 * removes the comment whatever it holds, and so do Backspace and Delete once
 * the note is empty; Enter commits a note that holds words, Shift+Enter writes
 * a newline. Cmd/Ctrl+Enter is the window's send, never the entry's, and every
 * key belongs to the input method while it composes.
 */
export const commentKeyAction = (
  key: NoteKey,
  at: CommentEntryState,
): CommentKeyAction => {
  if (at.composing) return 'default';
  if (key.key === 'Escape') return 'remove';
  if ((key.key === 'Backspace' || key.key === 'Delete') && at.empty) {
    return key.mod || key.shift ? 'default' : 'remove';
  }
  if (key.key !== 'Enter' || key.mod) return 'default';
  if (key.shift) return 'newline';

  return at.empty ? 'default' : 'commit';
};

/**
 * Whether a note holds words: the one rule for a comment's emptiness. A note of
 * nothing but whitespace is empty — it adds nothing to the stack, Backspace in
 * it removes the comment, and leaving it lets the comment go; a note with words
 * is kept as written when the focus leaves it.
 */
export const hasWords = (note: string): boolean => note.trim().length > 0;
