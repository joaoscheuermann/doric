// The footer's usage read over the client → host bridge (moved from the
// layout's provisional adapter, `threads.usage`): the same identifier guard,
// a lost bridge is the backend being unavailable, and a Thread the host does
// not know is a failed read, as the REST 404 was.

import { ConnectError } from '@connectrpc/connect';
import {
  type CallArg,
  type ClientServices,
  ContractError,
  fromConnectError,
  isContractError,
  type Services,
} from 'bundle/contracts';
import { decode, threadUsageSchema } from 'runtime/contracts';
import { ThreadUsageSchema as ThreadUsageMessageSchema } from 'runtime/contracts/gen/doric/runtime/v2/runtime_pb.js';
import type { z } from 'zod';

import {
  type CompactResponse,
  UsageService,
} from '../../contracts/gen/doric/usage/v1/usage_pb.js';
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

/** Reads and settings writes use the usual 10 s bridge deadline. */
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

/** A `ConnectError`'s Doric error; any other error unchanged. */
const doricError = (error: unknown): unknown =>
  error instanceof ConnectError ? fromConnectError(error) : error;

/** `value` parsed by `schema`, or `invalid_output`. */
const checked = <O extends z.ZodType>(
  schema: O,
  value: unknown,
): z.output<O> => {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new ContractError('invalid_output', parsed.error.message);
  }
  return parsed.data;
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
    // Summarizing a long conversation is a model generation, not a quick read.
    return await usage.compact(id, { deadline: Date.now() + 5 * 60_000 });
  } catch (error) {
    throw failure(error);
  }
};

/** The sentence each `compact` answer reads as on the footer. */
export const compactResultMessage = (result: CompactResult): string => {
  switch (result.status) {
    case 'compacted':
      return `Compacted ${result.condensedMessages} ${result.condensedMessages === 1 ? 'message' : 'messages'} into one summary (about ${result.tokensFreed} tokens freed).`;
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

/** The caller's epoch deadline as a relative `timeoutMs`, at least one. */
const timeoutOf = (call?: CallArg): { readonly timeoutMs?: number } => {
  const at =
    call !== undefined && 'deadline' in call ? call.deadline : undefined;
  if (typeof at !== 'number' || !Number.isFinite(at)) return {};
  return { timeoutMs: Math.max(1, Math.ceil(at - Date.now())) };
};

const invalidUsage = (): never => {
  throw new ContractError(
    'invalid_output',
    'usage/v1 answered outside its contract.',
  );
};

const compactRefusals = [
  'disabled',
  'missing_history',
  'nothing_to_compact',
] as const;

const compactFailures = ['summarizer_failed', 'unsafe_boundary'] as const;

const compactStatuses = [
  'missing',
  'inactive',
  'busy',
  'not_supported',
] as const;

/** `CompactResponse` as today's `CompactResult`. */
const compactOf = (message: CompactResponse): CompactResult => {
  if (message.status === 'compacted') {
    if (
      message.condensedMessages === undefined ||
      message.retainedMessages === undefined ||
      message.tokensFreed === undefined
    ) {
      return invalidUsage();
    }
    return {
      status: 'compacted',
      condensedMessages: message.condensedMessages,
      retainedMessages: message.retainedMessages,
      tokensFreed: message.tokensFreed,
    };
  }
  if (message.status === 'refused') {
    if (
      message.reason === undefined ||
      !(compactRefusals as readonly string[]).includes(message.reason)
    ) {
      return invalidUsage();
    }
    return {
      status: 'refused',
      reason: message.reason as (typeof compactRefusals)[number],
    };
  }
  if (message.status === 'failed') {
    if (
      message.code === undefined ||
      !(compactFailures as readonly string[]).includes(message.code)
    ) {
      return invalidUsage();
    }
    return {
      status: 'failed',
      code: message.code as (typeof compactFailures)[number],
    };
  }
  if ((compactStatuses as readonly string[]).includes(message.status)) {
    return { status: message.status as (typeof compactStatuses)[number] };
  }
  return invalidUsage();
};

/**
 * `usage/v1` over `UsageService`'s generated client, in today's shape: each
 * call's epoch deadline becomes its `timeoutMs`, an absent `thread_usage` is
 * `undefined`, and a `ConnectError` reads as its Doric error.
 */
export const usageHostOf = (services: Services): Usage => {
  const client = (services as ClientServices).use(UsageService);

  return {
    thread: async (threadId, call) => {
      try {
        const answer = await client.thread({ threadId }, timeoutOf(call));
        return answer.threadUsage === undefined
          ? undefined
          : checked(
              threadUsageSchema,
              decode(ThreadUsageMessageSchema, answer.threadUsage),
            );
      } catch (error) {
        throw failure(doricError(error));
      }
    },
    compact: async (threadId, call) => {
      try {
        return compactOf(await client.compact({ threadId }, timeoutOf(call)));
      } catch (error) {
        throw failure(doricError(error));
      }
    },
    compactionTarget: async (call) => {
      try {
        const answer = await client.compactionTarget({}, timeoutOf(call));
        return { pressurePercent: answer.pressurePercent };
      } catch (error) {
        throw failure(doricError(error));
      }
    },
    setCompactionTarget: async (input, call) => {
      try {
        const answer = await client.setCompactionTarget(
          { pressurePercent: input.pressurePercent },
          timeoutOf(call),
        );
        return { pressurePercent: answer.pressurePercent };
      } catch (error) {
        throw failure(doricError(error));
      }
    },
  };
};
