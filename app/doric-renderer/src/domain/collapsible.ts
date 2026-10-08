/**
 * The open state of a transcript block that folds: a thinking run, a tool call,
 * an activity summary.
 *
 * A block opens on its own while its work is in progress and it has something to
 * show, and folds away once the work settles. The reader may override that at
 * any time, and their choice then stands — over the default and over every later
 * change of the work — because it is their transcript to read. The override is
 * held as the block's node state, so the chevron and the keyboard write one
 * state; `null` here means the reader has not chosen and the default decides.
 */

import type { ToolStatus } from './projector';

/** The reader's choice of open/closed; `null` until they make one. */
export type Chosen = boolean | null;

/** What makes a block open while the reader has not chosen. */
export type Openness = {
  /** Whether the work is in progress. */
  readonly active: boolean;
  /** Whether there is anything to show. */
  readonly hasContent: boolean;
};

/** What a block shows now: the reader's choice, else the work's own answer. */
export const blockOpen = (chosen: Chosen, open: Openness): boolean =>
  chosen ?? (open.active && open.hasContent);

/**
 * The reader's next choice when they open or close a block: whatever the block
 * shows now, they want the other.
 */
export const blockToggled = (chosen: Chosen, open: Openness): boolean =>
  !blockOpen(chosen, open);

/**
 * A thinking block's answer: open while the run streams, and only once the
 * reasoning has read back into words — `body` is that prose, from
 * `reasoningText`, so an empty run never opens onto nothing.
 */
export const thinkingOpenness = (
  body: string,
  streaming: boolean,
): Openness => ({
  active: streaming,
  hasContent: body.length > 0,
});

/** A tool call's answer: open while it runs, once the call shows anything. */
export const toolOpenness = (
  status: ToolStatus,
  args: string,
  result: string | undefined,
  error: string | undefined,
): Openness => ({
  active: status === 'running',
  hasContent: args.length > 0 || result !== undefined || error !== undefined,
});

/** A settled burst's answer: an activity summary is never the live one. */
export const settledOpenness: Openness = { active: false, hasContent: true };
