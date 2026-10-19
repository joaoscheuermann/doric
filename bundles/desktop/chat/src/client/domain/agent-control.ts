import type { Turn } from './projector.js';
import type { LifecycleEvent } from './prompt-lifecycle.js';
import type { ThreadQueue } from './queue.js';
import type { Thread } from './workspace.js';

/**
 * What an agent Thread is doing, as far as the reader's three levers are
 * concerned: running (Pause applies), paused (Continue applies), failed or idle
 * (Retry applies). The host's own state names the run; the log names the pause,
 * because a prompt the reader interrupted stays unfinished until something takes
 * it up again.
 */
export type AgentStatus = 'running' | 'paused' | 'failed' | 'idle';

/** The handle the reader has on an agent Thread at this moment. */
export type AgentControl = {
  readonly status: AgentStatus;
  readonly canPause: boolean;
  readonly canContinue: boolean;
  readonly canRetry: boolean;
  /** The unfinished prompt Continue takes up again. */
  readonly pausedPromptId?: string;
  /** The reader's last words in the Thread, which Retry sends again. */
  readonly retryText?: string;
};

/** The last words the reader wrote in this conversation, when there are any. */
export const lastReaderText = (turns: readonly Turn[]): string | undefined => {
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const turn = turns[index];
    if (turn?.type === 'user' && turn.text.trim().length > 0) return turn.text;
  }
  return undefined;
};

/**
 * The pause still standing in the log, when one is: the newest lifecycle turn
 * decides, because a resume is what ends a pause. A pause a prompt finished
 * after is no longer standing, which the projector already records on the
 * event.
 */
export const standingPause = (
  turns: readonly Turn[],
): { readonly promptId: string } | undefined => {
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const turn = turns[index];
    if (turn?.type !== 'lifecycle') continue;
    const event: LifecycleEvent = turn.lifecycle;
    if (event.kind === 'resume') return undefined;
    if (event.standing) return { promptId: turn.promptId };
    return undefined;
  }
  return undefined;
};

/** Whether the conversation's most recent prompt ended in a failure. */
export const lastPromptFailed = (turns: readonly Turn[]): boolean => {
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const turn = turns[index];
    if (turn?.type === 'failure') return true;
    if (turn?.type === 'agent') return turn.status === 'failed';
    if (turn?.type === 'user') return false;
  }
  return false;
};

/**
 * The three levers an agent Thread offers, in the state it is in. The run is the
 * host's to start: the reader pauses it, takes a paused prompt up again, or
 * sends the last words once more — never a new prompt of its own.
 */
export const agentControl = (
  thread: Pick<Thread, 'state' | 'activePromptId'>,
  turns: readonly Turn[],
  queue: Pick<ThreadQueue, 'paused'> | undefined,
): AgentControl => {
  const running =
    thread.state === 'running' && thread.activePromptId !== undefined;
  const pause = running ? undefined : standingPause(turns);
  const paused = !running && (pause !== undefined || queue?.paused === true);
  const failed = !running && !paused && lastPromptFailed(turns);
  const retryText = lastReaderText(turns);

  return {
    status: running
      ? 'running'
      : paused
        ? 'paused'
        : failed
          ? 'failed'
          : 'idle',
    canPause: running,
    canContinue: paused,
    canRetry: !running && !paused && retryText !== undefined,
    ...(pause === undefined ? {} : { pausedPromptId: pause.promptId }),
    ...(retryText === undefined ? {} : { retryText }),
  };
};
