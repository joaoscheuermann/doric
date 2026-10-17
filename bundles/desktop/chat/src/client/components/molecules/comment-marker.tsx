// The state a comment's thread is in, as a short glyph: `✓` resolved, `?`
// waiting for the reader (the agent spoke last), `…` open. A reply row of the
// agent's turn wears the glyph, as the button that opens the thread; a
// user-turn line reads the state out to a screen reader only.

import { cn } from 'desktop/ui/utils';
import type { MouseEvent } from 'react';

import type { CommentThreadState } from '../../domain/comment-threads.js';

/** The glyph's own colour. */
const GLYPH_CLASS: Readonly<Record<CommentThreadState, string>> = {
  done: 'text-(color:--paper-green)',
  await: 'text-warning',
  open: 'text-muted-foreground',
};

/** The state as one glyph. */
export const STATE_GLYPH: Readonly<Record<CommentThreadState, string>> = {
  done: '✓',
  await: '?',
  open: '…',
};

/** The state in words, for a screen reader. */
export const STATE_LABEL: Readonly<Record<CommentThreadState, string>> = {
  done: 'resolved',
  await: 'waiting on you',
  open: 'open',
};

/** The words a marker reads out: the state, and the agent's replies. */
export const markerLabel = (
  state: CommentThreadState,
  replies: number,
): string =>
  `${STATE_LABEL[state]}${replies > 0 ? `, ${replies} ${replies === 1 ? 'reply' : 'replies'}` : ''}`;

/**
 * The glyph at the right end of a reply row: the thread's state alone, as the
 * button that opens the thread where its target is drawn.
 */
export function CommentStateGlyph({
  state,
  onClick,
}: {
  readonly state: CommentThreadState;
  readonly onClick: (event: MouseEvent<HTMLButtonElement>) => void;
}) {
  return (
    <button
      type="button"
      className={cn(
        'inline-flex size-5 shrink-0 cursor-pointer items-center justify-center rounded-sm font-sans text-xs font-semibold transition-colors hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring',
        GLYPH_CLASS[state],
      )}
      data-comment-state={state}
      title="Open thread"
      aria-label={`Open thread (${STATE_LABEL[state]})`}
      onClick={onClick}
    >
      {STATE_GLYPH[state]}
    </button>
  );
}
