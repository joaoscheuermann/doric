/**
 * Where the conversation surface scrolls as one sync pass lands on it.
 *
 * The prompt input is the conversation's tail: the transcript grows above it,
 * the line the reader's own turn trails sits under it, and the reader writes in
 * it. So the surface rests on the input — the opener seats the caret in the
 * prompt and puts the view on the input, the trail's last handle throws the
 * scroll back to it, and a reader who is there follows the input as the
 * transcript grows above them. Everything else is the reader's own: a pass that
 * fills older turns in above the tail leaves a reader who scrolled up exactly
 * where it found them, and no pass after the opener touches focus or the caret.
 */

/** What one sync pass does to the conversation's scroll. */
export type ScrollPlan =
  /** The pass opens the surface: the caret goes to the prompt, the view to the input. */
  | 'open'
  /** The pass keeps a reader who rests on the tail there as the transcript grows. */
  | 'follow'
  /** A trail jump to a block owns the scroll until its smooth movement ends. */
  | 'navigate'
  /** The pass holds the reader's scroll exactly as it found it. */
  | 'hold';

/** The pass as the rule reads it: the facts the surface measures. */
export type ScrollPass = {
  /** Whether this is the surface's first sync — the pass that opens it. */
  readonly opening: boolean;
  /** Whether a trail jump is moving the viewport toward a block. */
  readonly navigating: boolean;
  /** Whether the reader rests on the conversation's tail — the prompt input. */
  readonly atTail: boolean;
};

/**
 * The scroll plan for one sync pass: the opener wins outright, a jump to a
 * block owns the viewport while it moves, a reader resting on the tail follows
 * the input, and every other pass holds the reader's scroll.
 */
export const scrollPlan = (pass: ScrollPass): ScrollPlan => {
  if (pass.opening) return 'open';
  if (pass.navigating) return 'navigate';
  if (pass.atTail) return 'follow';
  return 'hold';
};

/** How far below the input's own place still counts as resting on it. */
const TAIL_SLACK = 2;

/**
 * The scroll offset that rests a block's bottom edge on the viewport's — the
 * place the prompt input takes when the surface opens on it or the trail throws
 * the scroll to it. `maxScroll` bounds it, so a block the surface cannot bring
 * that low stops as low as the surface scrolls.
 */
export const restOnBottom = (
  blockBottom: number,
  viewportHeight: number,
  maxScroll: number,
): number => Math.max(0, Math.min(blockBottom - viewportHeight, maxScroll));

/**
 * Whether a scroll position rests on the tail: at the input's own place or
 * below it, never above it. The room the surface keeps under the input is
 * still the tail's, so a reader who scrolled into it counts as resting there.
 */
export const restsOnTail = (scrollTop: number, tailTop: number): boolean =>
  scrollTop >= tailTop - TAIL_SLACK;
