// The footer's usage read over the client → host bridge (moved from the
// layout's provisional adapter, `threads.usage`): the same identifier guard,
// a lost bridge is the backend being unavailable, and a Thread the host does
// not know is a failed read, as the REST 404 was.

import { isContractError } from 'bundle/contracts';

import type {
  CompactResult,
  ThreadUsage,
  Usage,
} from '../../contracts/index.js';

export const usageMessages = {
  unavailable: 'Doric backend is unavailable.',
  invalidResponse: 'Doric returned an invalid response.',
  failed: 'The request could not be completed.',
  invalidIdentifier: 'The item identifier is invalid.',
  threadNotFound: 'The thread was not found.',
} as const;

/** The usage query's key, the one the renderer used. */
export const usageQueryKey = (threadId: string | undefined) =>
  ['thread', threadId, 'usage'] as const;

/** Every non-terminal bridge call carries a 10 s deadline [D10-2]. */
const deadline = () => ({ deadline: Date.now() + 10_000 });

const identifier = (value: unknown): string => {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 200 ||
    value.includes('\0')
  ) {
    throw new Error(usageMessages.invalidIdentifier);
  }
  return value;
};

const failure = (error: unknown): Error => {
  if (isContractError(error)) {
    if (
      error.code === 'unavailable' ||
      error.code === 'disconnected' ||
      error.code === 'generation_lost'
    ) {
      return new Error(usageMessages.unavailable);
    }
    if (error.code === 'invalid_output') {
      return new Error(usageMessages.invalidResponse);
    }
  }
  return new Error(usageMessages.failed);
};

/** A Thread's usage, or an `Error` with the message the REST path showed. */
export const readThreadUsage = async (
  usage: Usage,
  threadId: string,
): Promise<ThreadUsage> => {
  const id = identifier(threadId);
  let value: ThreadUsage | undefined;
  try {
    value = await usage.thread(id, deadline());
  } catch (error) {
    throw failure(error);
  }
  if (value === undefined) throw new Error(usageMessages.threadNotFound);
  return value;
};

/** The context fraction the executor condenses at, or an `Error` as above. */
export const readCompactionTarget = async (
  usage: Usage,
): Promise<{ readonly pressurePercent: number }> => {
  try {
    return await usage.compactionTarget(deadline());
  } catch (error) {
    throw failure(error);
  }
};

/** Moves the pressure line; the validated answer is what the host kept. */
export const writeCompactionTarget = async (
  usage: Usage,
  pressurePercent: number,
): Promise<{ readonly pressurePercent: number }> => {
  if (
    !Number.isInteger(pressurePercent) ||
    pressurePercent < 50 ||
    pressurePercent > 95
  ) {
    throw new Error('The compaction target must be a whole 50–95 percent.');
  }
  try {
    return await usage.setCompactionTarget({ pressurePercent }, deadline());
  } catch (error) {
    throw failure(error);
  }
};

/** One on-demand compaction, as the workspace REST path answers it. */
export const compactThread = async (
  usage: Usage,
  threadId: string,
): Promise<CompactResult> => {
  const id = identifier(threadId);
  try {
    return await usage.compact(id, deadline());
  } catch (error) {
    throw failure(error);
  }
};

/** The sentence each `compact` answer reads as on the footer. */
export const compactResultMessage = (result: CompactResult): string => {
  switch (result.status) {
    case 'compacted':
      return `Compacted ${result.condensedMessages} messages into one summary (about ${result.tokensFreed} tokens freed).`;
    case 'refused':
      return result.reason === 'disabled'
        ? 'Context compaction is disabled in the settings.'
        : result.reason === 'missing_history'
          ? 'This thread has no conversation to compact yet.'
          : 'Nothing condenses here: the recent conversation is already the smallest safe span.';
    case 'failed':
      return `The compaction failed (${result.code}); the log carries the attempt.`;
    case 'busy':
      return 'Wait for the active run (and the queued input) to finish.';
    default:
      return 'This thread cannot be compacted.';
  }
};
