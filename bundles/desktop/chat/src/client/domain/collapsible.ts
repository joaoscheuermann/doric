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

import type { CommentThreadState } from './comment-threads.js';
import type { ToolStatus } from './projector.js';

/** The reader's choice of open/closed; `null` until they make one. */
export type Chosen = boolean | null;

/** What makes a block open while the reader has not chosen. */
export type Openness = {
  /** Whether the work is in progress. */
  readonly active: boolean;
  /** Whether there is anything to show. */
  readonly hasContent: boolean;
  /** Whether the block stays open after its work settles until the reader folds it. */
  readonly defaultOpen?: boolean;
};

/** What a block shows now: the reader's choice, else the work's own answer. */
export const blockOpen = (chosen: Chosen, open: Openness): boolean =>
  chosen ?? ((open.defaultOpen ?? open.active) && open.hasContent);

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

/**
 * A tool call's answer: open while it runs, once the call shows anything, and
 * open by default for `edit` calls so the diff stands visible in the transcript,
 * and for `view-image` so the image the agent looked at stands beside it.
 */
export const toolOpenness = (
  status: ToolStatus,
  args: string,
  result: string | undefined,
  error: string | undefined,
  name?: string,
): Openness => ({
  active: status === 'running',
  hasContent: args.length > 0 || result !== undefined || error !== undefined,
  ...(name === 'edit' || name === 'write' || name === 'view-image'
    ? { defaultOpen: true }
    : {}),
});

/** A settled burst's answer: an activity summary is never the live one. */
export const settledOpenness: Openness = { active: false, hasContent: true };

/**
 * An agent's reply row's answer: folded once its thread is resolved, and open
 * otherwise — above all while the agent waits for the reader (`await`), so a
 * question is not missed. The thread's state is read live, so the row follows
 * a later resolution until the reader chooses.
 */
export const replyOpenness = (
  state: CommentThreadState,
  text: string,
): Openness => ({
  active: false,
  hasContent: text.trim().length > 0,
  defaultOpen: state !== 'done',
});

/**
 * A background terminal's answer: open when the command did not finish
 * cleanly — the one result a reader must not scroll past — and folded away
 * when it did, since its output is what the reader asked for earlier and the
 * header already names the command.
 */
export const terminalResultOpenness = (failed: boolean): Openness => ({
  active: false,
  hasContent: true,
  defaultOpen: failed,
});
