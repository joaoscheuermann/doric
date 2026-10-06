import type { InputSource } from './types.js';

/**
 * Why an interruption left a prompt unfinished. A live stop records its own
 * reason; `host_restarted` is what a boot appends when it discovers the
 * restart a run never got to record.
 */
export type PauseReason = 'host_stopped' | 'host_restarted' | 'reader_stopped';

/**
 * What the durable log says about one prompt that has not finished. It is read
 * from the prompt's own events, so no schema carries this state and no
 * migration is needed to introduce it.
 */
export interface PromptProgress {
  readonly projectId: string;
  readonly threadId: string;
  readonly promptId: string;
  /** The input `prompt.accepted` recorded, after configured-credential redaction. */
  readonly text: string;
  /** Sequence of the acceptance or most recent edit, independent of queue changes. */
  readonly revision?: number;
  readonly source: InputSource;
  /** Whether a run of this prompt ever started. */
  readonly started: boolean;
  /**
   * The pause that still stands: the reason of the last `prompt.paused` that no
   * `prompt.resumed` followed. Absent while a resume is the prompt's last word.
   */
  readonly paused?: PauseReason;
  /** A newer user input replaced this paused prompt; queued input never does. */
  readonly superseded?: boolean;
  /** How many times the host already took this prompt up again. */
  readonly attempts: number;
  readonly acceptedAt?: string;
  readonly queuedSequence?: number;
  readonly pausedSequence?: number;
  readonly first?: boolean;
}

/** The failure a prompt the host gives up on is closed with. */
export interface PromptFailure {
  readonly name: string;
  readonly code: string;
  readonly message: string;
}

/** The correlated result a delegated prompt delivers to its parent. */
export const delegatedResult = (
  threadId: string,
  promptId: string,
  requestPromptId: string,
  status: string,
  text: string,
): string =>
  [
    '# Delegated task result',
    '',
    `Child thread: ${threadId}`,
    `Child prompt: ${promptId}`,
    `Originating prompt: ${requestPromptId}`,
    `Status: ${status}`,
    '',
    '## Result',
    '',
    text,
  ].join('\n');

/**
 * Whether the host owes this prompt a run. Only the reader's own stop is theirs
 * to take up again: work the host interrupted is work the host owes them, and a
 * prompt that never ran is work nobody has done yet.
 */
export const hostOwesRun = ({ paused, superseded }: PromptProgress): boolean =>
  !superseded && paused !== 'reader_stopped';

/**
 * How many times the host takes the same prompt up again before it gives up.
 * Counted from the prompt's own `prompt.resumed` events, so a host that keeps
 * dying on one prompt stops circling it: the third interruption closes it
 * instead of resuming it again. It bounds the automatic resume only — a reader
 * who asks for the prompt again is always obeyed.
 */
export const attemptBudget = 2;

/** Whether the host has already taken this prompt up as often as it may. */
export const resumeExhausted = ({ attempts }: PromptProgress): boolean =>
  attempts >= attemptBudget;

/**
 * The failure a prompt that exhausted its attempts is closed with. Its message
 * is the reader's, so it says what happened and what to do about it.
 */
export const resumeExhaustedError: PromptFailure = {
  name: 'ResumeExhaustedError',
  code: 'resume_exhausted',
  message:
    'A execução foi interrompida três vezes por reinício do host e não foi ' +
    'retomada de novo. O trabalho pode estar incompleto; mande o prompt ' +
    'novamente para continuar.',
};
