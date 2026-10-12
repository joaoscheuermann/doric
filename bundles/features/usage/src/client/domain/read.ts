// The footer's usage read over the client → host bridge (moved from the
// layout's provisional adapter, `threads.usage`): the same identifier guard,
// a lost bridge is the backend being unavailable, and a Thread the host does
// not know is a failed read, as the REST 404 was.

import { isContractError } from 'bundle/contracts';

import type { ThreadUsage, Usage } from '../../contracts/index.js';

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
