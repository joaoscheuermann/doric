/**
 * Where the conversation surface scrolls as one sync pass lands on it.
 *
 * Opening a conversation and choosing the Prompt Input handle follow the end
 * of the scrollable content. Following remains active while the transcript
 * grows and stops when the reader scrolls. A reader who left the end keeps the
 * same visible block through later updates. Only the opener moves the caret.
 */

/** What one sync pass does to the conversation's scroll. */
export type ScrollPlan =
  /** The pass opens the surface: the caret goes to the prompt, the view to the end. */
  | 'open'
  /** The pass keeps the viewport at the end as the transcript grows. */
  | 'follow'
  /** A trail jump owns the scroll through its immediate landing. */
  | 'navigate'
  /** The pass holds the reader's scroll exactly as it found it. */
  | 'hold';

/** The pass as the rule reads it: the facts the surface measures. */
export type ScrollPass = {
  /** Whether this is the surface's first sync — the pass that opens it. */
  readonly opening: boolean;
  /** Whether a trail jump is landing in the current frame. */
  readonly navigating: boolean;
  /** Whether the reader has chosen to follow the end. */
  readonly following: boolean;
};

/**
 * The scroll plan for one sync pass: the opener wins outright, a jump to a
 * block owns the viewport while it lands, a reader following the end stays
 * there, and every other pass holds the visible content.
 */
export const scrollPlan = (pass: ScrollPass): ScrollPlan => {
  if (pass.opening) return 'open';
  if (pass.navigating) return 'navigate';
  if (pass.following) return 'follow';
  return 'hold';
};

/** A small tolerance for a reader who scrolls back to the end by hand. */
const END_SLACK = 32;

export const atEnd = (
  scrollTop: number,
  scrollHeight: number,
  viewportHeight: number,
): boolean => scrollHeight - viewportHeight - scrollTop <= END_SLACK;

/** Keep the reader's own scroll while compensating for content inserted above a visible block. */
export const preserveVisibleBlock = (
  currentScrollTop: number,
  blockTopBefore: number,
  blockTopAfter: number,
): number => currentScrollTop + blockTopAfter - blockTopBefore;
