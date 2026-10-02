import type { Turn, UserTurn } from './projector';

/**
 * The thread navigation rail's vocabulary: the prompts the reader wrote become
 * handles stacked down a thin rail inside the conversation's scroll view. The
 * rules that choose the handles and name the one the reader is looking at are
 * pure functions of their arguments; the surface around them only measures the
 * DOM and hands the numbers over.
 */

/** One handle on the rail: a prompt of the reader's, and its hover's content. */
export type PromptMarker = {
  /** The prompt this handle jumps to — the id its block carries in the DOM. */
  readonly promptId: string;
  /** The prompt's words, all a hover's popover shows. */
  readonly text: string;
};

/** Whether a turn is a prompt the reader wrote that the log holds. */
const isMarkerTurn = (turn: Turn): turn is UserTurn =>
  turn.type === 'user' && turn.accepted && turn.delegated === undefined;

/**
 * The markers a rail holds: one per prompt the reader wrote, in the order the
 * transcript holds them. A prompt the host has not accepted yet is not yet a
 * turn of the conversation, and a delegated input is not the reader's own —
 * neither takes a marker.
 */
export const promptMarkers = (
  turns: readonly Turn[],
): readonly PromptMarker[] =>
  turns.filter(isMarkerTurn).map((turn) => ({
    promptId: turn.promptId,
    text: turn.text.trim(),
  }));

/**
 * The marker a scroll position speaks for: the prompt at or nearest above the
 * viewport's top, and the first measured prompt while the reader is above every
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
