import type { TurnComment } from '../../contracts/index.js';
import {
  type CommentThread,
  type CommentThreads,
  foldComment,
} from './comment-threads.js';
import type { ThinkingTurn, Turn, UserTurn } from './projector.js';

/** A prompt the reader has sent that the log does not hold yet. */
export type PendingSend = {
  readonly text: string;
  /** The comments the prompt carries, drawn above its words meanwhile. */
  readonly comments?: readonly TurnComment[];
  /**
   * How many prompts of the reader's own the log held when this one was sent.
   * One more of them is the acceptance — the only way the log gains a prompt of
   * the reader's own — so counting them, rather than watching whichever turn is
   * last, is what keeps the words from being drawn again once the agent's answer
   * makes some other turn the last one.
   */
  readonly before: number;
};

/**
 * The prompts of a turn the reader wrote: not a Thread's input, a background
 * terminal's result or a bundle's instruction, which the reader never sent.
 */
const ownPromptIds = (turn: Turn): readonly string[] => {
  if (
    turn.type === 'user' &&
    turn.delegated === undefined &&
    turn.terminal === undefined &&
    turn.instruction === undefined
  )
    return [turn.promptId];
  if (turn.type === 'queued')
    return turn.items
      .filter((item) => item.source.kind === 'user')
      .map((item) => item.promptId);
  return [];
};

/**
 * A comment the reader sent with a prompt the host accepted, while the log may
 * not hold it yet: the send's flush writes it a moment after the acceptance,
 * and a surface draws it from the send on, as the log will.
 */
export type SentComment = {
  readonly promptId: string;
  readonly comment: TurnComment;
};

/**
 * A prompt the reader has sent that the log does not hold yet. It carries no
 * prompt id — there is none until the host accepts it — and `accepted: false`,
 * which is what a surface dims it by.
 */
const sentTurn = (pending: PendingSend): UserTurn => ({
  type: 'user',
  promptId: '',
  events: [],
  text: pending.text,
  accepted: false,
  comments: pending.comments ?? [],
  awaiting: false,
});

/**
 * A user turn wearing the comments sent with its prompt that the log does not
 * hold yet, after the ones it does, in the order they were sent; the same turn
 * when the log holds them all.
 */
const withSent = (turn: Turn, outbox: readonly SentComment[]): Turn => {
  if (turn.type !== 'user') return turn;
  const held = new Set(turn.comments.map((comment) => comment.commentId));
  const missing = outbox.filter(
    (sent) =>
      sent.promptId === turn.promptId && !held.has(sent.comment.commentId),
  );
  return missing.length === 0
    ? turn
    : {
        ...turn,
        comments: [...turn.comments, ...missing.map((sent) => sent.comment)],
      };
};

/**
 * The comment threads with the comments sent that the log does not hold yet
 * folded in, as the log will fold them; the same threads when there are none.
 */
export const withSentThreads = (
  threads: CommentThreads,
  outbox: readonly SentComment[],
): CommentThreads => {
  if (outbox.length === 0) return threads;
  const folded = new Map<string, CommentThread>(threads);
  for (const sent of outbox) foldComment(folded, sent.comment);
  return folded;
};

/**
 * The agent's first step, before it exists: an empty run of reasoning, which a
 * surface draws as the block the agent's work will appear in.
 */
const awaitingTurn = (promptId: string): ThinkingTurn => ({
  type: 'thinking',
  promptId,
  events: [],
  text: '',
  streaming: true,
});

/**
 * The turns a conversation surface draws: the log's own, plus what it is waiting
 * for. Neither is durable — the log never holds them — and each is drawn only
 * while the log is behind it:
 *
 * - the reader's words, while no prompt of the reader's own has been accepted
 *   since they were sent;
 * - the agent's first step, while the log's last turn is a prompt the agent has
 *   not touched yet;
 * - the comments sent with an accepted prompt, above its words, while the log
 *   does not hold them yet (`outbox`).
 *
 * The waiting step is placed before the reader's words, because it belongs to
 * the prompt before them: a prompt sent while another is still unanswered stands
 * after that prompt's `awaiting` turn, not before it.
 */
export const withPendingTurns = (
  turns: readonly Turn[],
  pending: PendingSend | undefined,
  outbox: readonly SentComment[] = [],
): readonly Turn[] => {
  const sent =
    outbox.length === 0 ? turns : turns.map((turn) => withSent(turn, outbox));
  const changed = sent.some((turn, index) => turn !== turns[index]);
  return withWaiting(changed ? sent : turns, pending);
};

/** The turns, followed by the ones the surface waits for. */
const withWaiting = (
  turns: readonly Turn[],
  pending: PendingSend | undefined,
): readonly Turn[] => {
  const last = turns.at(-1);
  const waiting: Turn[] = [];

  if (last?.type === 'user' && last.awaiting)
    waiting.push(awaitingTurn(last.promptId));
  if (
    pending !== undefined &&
    new Set(turns.flatMap(ownPromptIds)).size <= pending.before
  )
    waiting.push(sentTurn(pending));

  return waiting.length === 0 ? turns : [...turns, ...waiting];
};
