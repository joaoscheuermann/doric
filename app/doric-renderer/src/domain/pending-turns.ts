import type { ThinkingTurn, Turn, UserTurn } from './projector';

/** A prompt the reader has sent that the log does not hold yet. */
export type PendingSend = {
  readonly text: string;
  /**
   * How many prompts of the reader's own the log held when this one was sent.
   * One more of them is the acceptance — the only way the log gains a prompt of
   * the reader's own — so counting them, rather than watching whichever turn is
   * last, is what keeps the words from being drawn again once the agent's answer
   * makes some other turn the last one.
   */
  readonly before: number;
};

/** Whether a turn is a prompt the reader wrote, rather than a Thread's input. */
const isOwnPrompt = (turn: Turn): boolean =>
  turn.type === 'user' && turn.delegated === undefined;

/**
 * A prompt the reader has sent that the log does not hold yet. It carries no
 * prompt id — there is none until the host accepts it — and `accepted: false`,
 * which is what a surface dims it by.
 */
const sentTurn = (text: string): UserTurn => ({
  type: 'user',
  promptId: '',
  events: [],
  text,
  accepted: false,
  awaiting: false,
});

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
 *   not touched yet.
 *
 * The waiting step is placed before the reader's words, because it belongs to
 * the prompt before them: a prompt sent while another is still unanswered stands
 * after that prompt's `awaiting` turn, not before it.
 */
export const withPendingTurns = (
  turns: readonly Turn[],
  pending: PendingSend | undefined,
): readonly Turn[] => {
  const last = turns.at(-1);
  const waiting: Turn[] = [];

  if (last?.type === 'user' && last.awaiting)
    waiting.push(awaitingTurn(last.promptId));
  if (
    pending !== undefined &&
    turns.filter(isOwnPrompt).length <= pending.before
  )
    waiting.push(sentTurn(pending.text));

  return waiting.length === 0 ? turns : [...turns, ...waiting];
};
