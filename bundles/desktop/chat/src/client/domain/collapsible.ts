/**
 * The open state of the chat's own folding blocks: a thinking run, a tool call,
 * an activity summary, a reply row and the rest.
 *
 * The generic rule — open while the work is in progress and has something to
 * show, folded once it settles, the reader's choice standing over both — is the
 * platform's `desktop/ui/collapsible-block`. Each function here answers the
 * `Openness` that rule reads for one of the chat's blocks.
 */

import type { ErrorInfo } from 'desktop/reads';
import type { Openness } from 'desktop/ui/collapsible-block';

import type { CommentThreadState } from './comment-threads.js';
import type { ToolStatus } from './projector.js';

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
 * with `openByDefault` open after it settles too, until the reader closes it.
 * Which tools are open by default is `toolDrawing`'s answer.
 */
export const toolOpenness = (
  status: ToolStatus,
  args: string,
  result: string | undefined,
  error: ErrorInfo | undefined,
  openByDefault = false,
): Openness => ({
  active: status === 'running',
  hasContent: args.length > 0 || result !== undefined || error !== undefined,
  ...(openByDefault ? { defaultOpen: true } : {}),
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
