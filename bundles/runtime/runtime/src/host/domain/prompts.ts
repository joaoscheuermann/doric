import type { PromptFailure, PromptProgress } from '../store/types.js';

/*
 * Moved from agents/doric (workspace/prompts.ts, design 57 §11.1); the
 * progress and failure shapes are the store's (store/types.ts).
 */

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
  !superseded && paused !== 'reader_stopped' && paused !== 'storage_low';

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
