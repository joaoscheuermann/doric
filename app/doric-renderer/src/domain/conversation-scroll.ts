/**
 * Where the conversation surface scrolls as one sync pass lands on it.
 *
 * A conversation surface opens on the input exactly once — its first sync seats
 * the caret in the prompt and scrolls the view to it. Everything that comes
 * after is the reader's own: a pass that fills older turns in above the tail
 * keeps a reader at the bottom at the bottom, and every other pass leaves the
 * reader's scroll exactly where it found it. Focus and the caret are the
 * opener's alone; no later pass may touch them.
 */
export type ScrollPlan =
  /** The pass opens the surface: the caret goes to the prompt, the view to the input. */
  | 'open'
  /** The pass pins the tail: the transcript fills in above it and the reader follows the bottom. */
  | 'pin'
  /** The pass holds the reader's scroll exactly as it found it. */
  | 'hold';

/** The pass as the rule reads it: the facts the surface measures. */
export type ScrollPass = {
  /** Whether this is the surface's first sync — the pass that opens it. */
  readonly opening: boolean;
  /** Whether older turns are still filling in above the tail. */
  readonly filling: boolean;
  /** Whether the reader sits at the conversation's tail. */
  readonly atBottom: boolean;
};

/**
 * The scroll plan for one sync pass: the opener wins outright, a fill pass
 * pins the tail only for a reader at the bottom, and every other pass — a
 * reader who scrolled up mid-fill included — holds the reader's scroll.
 */
export const scrollPlan = (pass: ScrollPass): ScrollPlan => {
  if (pass.opening) return 'open';
  if (pass.filling && pass.atBottom) return 'pin';
  return 'hold';
};
