import type { Turn } from './projector';

/**
 * The thread navigation rail's vocabulary: prompts, queued receipts and child
 * results become handles inside the conversation's scroll view. The
 * rules that choose the handles and name the one the reader is looking at are
 * pure functions of their arguments; the surface around them only measures the
 * DOM and hands the numbers over.
 */

/** One handle on the rail and the block it jumps to. */
type MarkerBase = {
  /** The id carried by the corresponding transcript block. */
  readonly promptId: string;
  /** The words its hover's popover shows. */
  readonly text: string;
};

export type ThreadMarker = MarkerBase &
  (
    | { readonly kind: 'prompt' | 'queued' }
    | { readonly kind: 'result'; readonly threadId: string }
  );

/**
 * One marker per visible destination, in transcript order. A grouped queued
 * receipt is one block and gets one marker; its later execution is a separate
 * prompt block. Parent instructions and unaccepted drafts have no marker.
 */
export const threadMarkers = (
  turns: readonly Turn[],
): readonly ThreadMarker[] =>
  turns.flatMap((turn): readonly ThreadMarker[] => {
    if (turn.type === 'queued')
      return turn.items.length === 0
        ? []
        : [
            {
              kind: 'queued',
              promptId: turn.promptId,
              text: turn.items.map((item) => item.text.trim()).join('\n\n'),
            },
          ];
    if (turn.type !== 'user' || !turn.accepted) return [];
    if (turn.delegated?.kind === 'result')
      return [
        {
          kind: 'result',
          promptId: turn.promptId,
          threadId: turn.delegated.threadId,
          text: turn.delegated.text.trim(),
        },
      ];
    return turn.delegated === undefined
      ? [{ kind: 'prompt', promptId: turn.promptId, text: turn.text.trim() }]
      : [];
  });

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
 * The marker a scroll position speaks for: the block at or nearest above the
 * reading line, or a subthread result already visible below it. Results can
 * be too short to ever reach the reading line near the end of a thread.
 * `-1` when there is nothing to highlight.
 */
export const activeMarkerIndex = (
  markers: readonly {
    readonly kind: ThreadMarker['kind'];
    readonly top: number | null;
  }[],
  viewportTop: number,
  viewportHeight: number,
): number => {
  const readingTop = viewportTop + viewportHeight * READING_LINE;
  const viewportBottom = viewportTop + viewportHeight;
  let active = -1;
  let first = -1;
  for (let index = 0; index < markers.length; index += 1) {
    const { kind, top } = markers[index];
    if (top === null) continue;
    if (first === -1) first = index;
    if (top <= readingTop || (kind === 'result' && top < viewportBottom))
      active = index;
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
