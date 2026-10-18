// The state a comment's thread is in, as the words a screen reader reads. The
// user turn's line draws no state of its own — a sent comment is immutable and
// the line reads the thread's state out only — while an agent's reply row wears
// the state as the comment's pin (`comment-thread-pin.tsx`), coloured by it and
// opening the thread.

import type { CommentThreadState } from '../../domain/comment-threads.js';

/** The state in words, for a screen reader. */
export const STATE_LABEL: Readonly<Record<CommentThreadState, string>> = {
  done: 'resolved',
  await: 'waiting on you',
  open: 'open',
};

/** The words a marker reads out: the state, and the agent's replies. */
export const markerLabel = (state: CommentThreadState, replies: number): string =>
  `${STATE_LABEL[state]}${replies > 0 ? `, ${replies} ${replies === 1 ? 'reply' : 'replies'}` : ''}`;
