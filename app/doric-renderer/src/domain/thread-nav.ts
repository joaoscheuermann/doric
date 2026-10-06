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

/**
 * The marker a scroll position speaks for: the block at or nearest above the
 * viewport's top, and the first measured block while the reader is above every
 * marker. The tops ascend through the transcript, so the last measured marker
 * at or above the top is the nearest one. `-1` when there is nothing to
 * highlight.
 */
export const activeMarkerIndex = (
  markerTops: readonly (number | null)[],
  viewportTop: number,
): number => {
  let active = -1;
  let first = -1;
  for (let index = 0; index < markerTops.length; index += 1) {
    const top = markerTops[index];
    if (top === null) continue;
    if (first === -1) first = index;
    if (top <= viewportTop) active = index;
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
