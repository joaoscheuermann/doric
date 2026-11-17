import type { Turn } from './projector.js';

/**
 * The thread navigation rail's vocabulary: the reader's accepted prompts
 * become handles beside the conversation's scroll view. The rules that choose
 * the handles and name the one the reader is looking at are pure functions of
 * their arguments; the surface around them only measures the DOM and hands the
 * numbers over.
 */

/**
 * One handle on the rail and the prompt block it jumps to: one per accepted
 * reader prompt that no other Thread delegated. Queued receipts, parent
 * instructions, subthread results and unaccepted drafts have none.
 */
export type ThreadMarker = {
  /** The id the prompt's transcript block carries as `data-prompt-id`. */
  readonly promptId: string;
  /**
   * The words its hover's popover shows: the prompt's trimmed text, or its
   * comments' trimmed notes joined by newlines when the prompt has no words.
   */
  readonly text: string;
};

/**
 * One marker per accepted, non-delegated user prompt, in transcript order.
 *
 * Accepts the turns the surface draws and returns a new array; it never fails
 * and never mutates `turns`. Queued turns, unaccepted drafts and prompts
 * carrying `delegated` (a parent's instruction or a subthread's result) give no
 * marker, so each returned `promptId` names a block a reader wrote.
 */
export const threadMarkers = (
  turns: readonly Turn[],
): readonly ThreadMarker[] =>
  turns.flatMap((turn): readonly ThreadMarker[] => {
    if (turn.type !== 'user' || !turn.accepted || turn.delegated !== undefined)
      return [];
    // A prompt of comments alone has no words; its notes stand for it.
    const words =
      turn.text.trim() ||
      turn.comments.map((comment) => comment.text.trim()).join('\n');
    return [{ promptId: turn.promptId, text: words }];
  });

/**
 * Whether two readings of the rail are the same handles: the same blocks and
 * words in the same order. True for the same array, or for arrays of equal
 * length whose markers match on `promptId` and `text` index by index. A flush
 * of deltas changes no handle, and a rail that is told so keeps the handles it
 * drew. Never fails.
 */
export const sameMarkers = (
  previous: readonly ThreadMarker[],
  next: readonly ThreadMarker[],
): boolean =>
  previous === next ||
  (previous.length === next.length &&
    previous.every((marker, index) => {
      const other = next[index];
      return (
        other !== undefined &&
        marker.promptId === other.promptId &&
        marker.text === other.text
      );
    }));

/** Where a clicked block's top rests in the viewport when scrolling permits it. */
const READING_LINE = 0.4;

/** Scroll to a marker with its top at the reading line, bounded by the content edges. */
export const markerScrollTop = (
  blockTop: number,
  viewportHeight: number,
  maxScroll: number,
): number =>
  Math.max(0, Math.min(blockTop - viewportHeight * READING_LINE, maxScroll));

/**
 * The marker a scroll position speaks for.
 *
 * Accepts each marker's block top in scroll-content pixels, in marker order
 * (`null` when its block is not mounted or measured), with the viewport's
 * scroll offset and height. Returns the index of the last measured block whose
 * top is at or above the reading line (40% down the viewport). If no measured
 * block has reached it, returns the first measured index. Returns `-1` when no
 * block is measured. Never fails; the result is always `-1` or the index of a
 * marker whose `top` is not `null`.
 */
export const activeMarkerIndex = (
  markers: readonly { readonly top: number | null }[],
  viewportTop: number,
  viewportHeight: number,
): number => {
  const readingTop = viewportTop + viewportHeight * READING_LINE;
  let active = -1;
  let first = -1;
  for (let index = 0; index < markers.length; index += 1) {
    const { top } = markers[index];
    if (top === null) continue;
    if (first === -1) first = index;
    if (top <= readingTop) active = index;
  }
  return active === -1 ? first : active;
};

/** Distance from the hovered handle, capped at the rail's resting level. */
export const markerEmphasis = (
  index: number,
  hovered: number,
): 0 | 1 | 2 | 3 => {
  if (hovered < 0) return 3;
  const distance = Math.abs(index - hovered);
  return distance >= 3 ? 3 : distance === 2 ? 2 : distance === 1 ? 1 : 0;
};
