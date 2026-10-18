import * as React from 'react';
import { cn } from 'cn';

/**
 * Where a comment's thread stands, as the pin's fill: the same vocabulary the
 * conversation and the canvas share (`open`, `await`, `done`, and `draft` for a
 * comment still in the composer stack).
 */
export type CommentPinState = 'open' | 'await' | 'done' | 'draft';

/**
 * The pin's fill, by state. The colour alone says where the thread stands — a
 * resolved thread is green, an awaiting one is orange, an open one wears the
 * primary, and a draft is a dashed outline.
 */
const PIN_FILL: Readonly<Record<CommentPinState, string>> = {
  open: 'bg-primary text-primary-foreground',
  await: 'bg-[var(--paper-orange)] text-[#1d1300]',
  done: 'bg-[var(--paper-green)] text-primary-foreground',
  draft: 'border-[1.5px] border-dashed border-primary bg-popover text-primary',
};

/**
 * The comment pin: a teardrop, round but for its bottom-left corner — the tip,
 * which sits on the point or the row it annotates. It carries its number, grows
 * a little on hover and on focus, and takes its colour from the thread's state.
 */
export const COMMENT_PIN_CLASS =
  'inline-flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-[9999px_9999px_9999px_0] text-[11px] font-semibold tabular-nums shadow-md transition-transform duration-120 origin-bottom-left hover:scale-110 focus-visible:scale-110 outline-none focus-visible:outline-2 focus-visible:outline-ring';

/** One pin state's fill, with the caller's own classes. */
export const commentPinClass = (state: CommentPinState, className?: string): string =>
  cn(COMMENT_PIN_CLASS, PIN_FILL[state], className);

export interface CommentPinProps extends Omit<React.ComponentProps<'button'>, 'type'> {
  readonly state: CommentPinState;
}

/**
 * The comment pin both surfaces draw — the conversation's reply row and the
 * canvas's layer — so the same thread reads the same way in both places. It is
 * presentation only: the caller wires what a press means (opening the thread's
 * popover, opening it on the canvas) and where the pin sits.
 */
export function CommentPin({ state, className, children, ...props }: CommentPinProps) {
  return (
    <button
      type="button"
      data-state={state}
      className={commentPinClass(state, className)}
      {...props}
    >
      {children}
    </button>
  );
}
