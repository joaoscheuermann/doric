// The chat's host adapter (§7.5, §11): the `window.doric.threads.*` members
// the conversation called, over `runtime.threads/v1`. Each member answers
// what the semantic preload answered: the main-process guard runs first
// (`app/desktop/doric/src/workspace/validation.ts`, same messages), then the REST
// route's own input checks, and every host outcome becomes the exact message
// the REST route sent (`bundles/foundation/transport/src/host/routes/threads.ts`, R-ERR).
// Failures reject with `Error(message)`, which `messageFrom` shows.

import { isContractError } from 'bundle/contracts';
import {
  type RuntimeThreads,
  RuntimeThreadsV1,
  storageMessage,
} from 'runtime/contracts';
import { z } from 'zod';

import type { QueuedPrompt, ThreadQueue } from '../domain/queue.js';
import type { Thread, ThreadHistory } from '../domain/workspace.js';
import { chatServices, currentHistory } from '../services/chat-services.js';
import {
  type HistorySnapshots,
  threadHistoryFrom,
} from './history-contract.js';

export interface PromptReceipt {
  readonly promptId: string;
}

/** A steer's receipt: taken by the running prompt, or queued instead. */
export interface SteerReceipt extends PromptReceipt {
  readonly status: 'steered' | 'queued';
}

export interface ChatThreadsApi {
  get(threadId: string): Promise<Thread | undefined>;
  history(threadId: string): Promise<ThreadHistory | null>;
  prompt(threadId: string, prompt: string): Promise<PromptReceipt>;
  /**
   * Sends input into the running prompt `promptId`; `interrupt` also aborts
   * its current step.
   */
  steer(
    threadId: string,
    prompt: string,
    options: { readonly promptId: string; readonly interrupt?: boolean },
  ): Promise<SteerReceipt>;
  resume(threadId: string, promptId: string): Promise<Thread>;
  /** Sends the Thread's last prompt again; the host reads it from the log. */
  retry(threadId: string): Promise<PromptReceipt>;
  rewind(
    threadId: string,
    promptId: string,
    prompt: string,
  ): Promise<PromptReceipt>;
  interrupt(threadId: string, promptId: string): Promise<void>;
  queue(threadId: string): Promise<ThreadQueue>;
  queuedPrompt(threadId: string, promptId: string): Promise<QueuedPrompt>;
  editQueued(
    threadId: string,
    promptId: string,
    text: string,
    revision: number,
  ): Promise<QueuedPrompt>;
  removeQueued(threadId: string, promptId: string): Promise<void>;
  resumeQueue(threadId: string): Promise<Thread>;
}

/** The REST client's text for a host it could not reach. */
export const unavailableMessage = 'Doric backend is unavailable.';
/** The REST client's text for an answer that failed its shape check. */
export const invalidResponseMessage = 'Doric returned an invalid response.';
/** The REST route's final handler text for an unexpected failure. */
export const internalMessage = 'The request could not be completed.';

const notFound = 'The thread was not found.';
const cannotPerform = 'The thread cannot perform this operation.';
const promptNotFound = 'The prompt was not found in this Thread.';
const promptIdRequired = 'A promptId is required.';

const fail = (message: string): never => {
  throw new Error(message);
};

/** The REST `conflict` text: storage pause has its own sentence. */
const conflict = (reason: string): never =>
  fail(reason === 'storage_low' ? storageMessage : cannotPerform);

// Main-process guards (`validation.ts`), same order and messages.

const identifier = (value: unknown): string => {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 200 ||
    value.includes('\0')
  ) {
    return fail('The item identifier is invalid.');
  }

  return value;
};

const promptText = (value: unknown): string => {
  if (typeof value !== 'string' || value.trim().length === 0) {
    return fail('Enter a prompt before continuing.');
  }

  return value;
};

// REST route input checks.

const uuid = z.uuid();
const isUuid = (value: string): boolean => uuid.safeParse(value).success;

const threadId = (value: unknown): string => {
  const id = identifier(value);

  return isUuid(id) ? id : fail('The thread ID is invalid.');
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

/** The REST client's Thread check (`api.ts` `threadFrom`). */
const threadFrom = (value: unknown): Thread => {
  if (
    !isRecord(value) ||
    typeof value.id !== 'string' ||
    typeof value.name !== 'string' ||
    typeof value.projectId !== 'string' ||
    (value.parentThreadId !== undefined &&
      typeof value.parentThreadId !== 'string') ||
    typeof value.state !== 'string' ||
    typeof value.cwd !== 'string' ||
    (value.cwdRepo !== undefined &&
      value.cwdRepo !== 'git' &&
      value.cwdRepo !== 'github') ||
    typeof value.createdAt !== 'string' ||
    typeof value.updatedAt !== 'string'
  ) {
    return fail(invalidResponseMessage);
  }

  return value as Thread;
};

const receiptFrom = (promptId: unknown): PromptReceipt =>
  typeof promptId === 'string' && promptId.length > 0
    ? { promptId }
    : fail(invalidResponseMessage);

/**
 * What a failed host call reads as. A bridge without the host is what the
 * REST client's failed fetch was; an output that failed its contract schema
 * is the REST client's shape check; anything else is the route's 500.
 */
export const hostFailureMessage = (error: unknown): string => {
  if (isContractError(error)) {
    if (
      error.code === 'unavailable' ||
      error.code === 'disconnected' ||
      error.code === 'generation_lost'
    ) {
      return unavailableMessage;
    }

    if (error.code === 'invalid_output') return invalidResponseMessage;
  }

  return internalMessage;
};

export interface ThreadsApiSources {
  readonly threads: () => RuntimeThreads;
  readonly history: () => HistorySnapshots | undefined;
}

export const createThreadsApi = (
  sources: ThreadsApiSources,
): ChatThreadsApi => {
  const host = async <T>(
    run: (threads: RuntimeThreads) => Promise<T>,
  ): Promise<T> => {
    let threads: RuntimeThreads;

    try {
      threads = sources.threads();
    } catch (error) {
      return fail(hostFailureMessage(error));
    }

    try {
      return await run(threads);
    } catch (error) {
      return fail(hostFailureMessage(error));
    }
  };

  return {
    get: async (id) => {
      const checked = threadId(id);
      const thread = await host((threads) => threads.thread(checked));

      // A deleted Thread is a normal outcome, not a transient failure.
      return thread === undefined ? undefined : threadFrom(thread);
    },

    history: async (id) => {
      const checked = identifier(id);
      const history = sources.history();

      if (history === undefined) return null;

      try {
        return threadHistoryFrom(await history.read(checked));
      } catch {
        // The cache is best effort: a failed read is no snapshot.
        return null;
      }
    },

    prompt: async (id, prompt) => {
      identifier(id);
      const text = promptText(prompt);
      const checked = threadId(id);
      const result = await host((threads) =>
        threads.prompt({ id: checked, prompt: text }),
      );

      if (result.status === 'missing') return fail(notFound);
      if (result.status !== 'accepted') return conflict('inactive');

      return receiptFrom(result.promptId);
    },

    steer: async (id, prompt, options) => {
      identifier(id);
      const target = identifier(options.promptId);
      const text = promptText(prompt);
      const checked = threadId(id);

      if (!isUuid(target)) return fail(promptIdRequired);

      const result = await host((threads) =>
        threads.steer({
          id: checked,
          prompt: text,
          promptId: target,
          ...(options.interrupt === true ? { interrupt: true } : {}),
        }),
      );

      if (result.status === 'steered' || result.status === 'queued')
        return { ...receiptFrom(result.promptId), status: result.status };
      if (result.status === 'missing') return fail(notFound);
      return conflict('inactive');
    },

    retry: async (id) => {
      const checked = threadId(id);
      const result = await host((threads) => threads.retry({ id: checked }));
      if (result.status !== 'accepted') return conflict(result.status);
      return receiptFrom(result.promptId);
    },

    resume: async (id, promptId) => {
      identifier(id);
      const target = identifier(promptId);
      const checked = threadId(id);

      if (!isUuid(target)) return fail(promptIdRequired);

      const result = await host((threads) =>
        threads.resume({ id: checked, promptId: target }),
      );

      if (result.status === 'missing') return fail(notFound);
      if (result.status === 'unknown_prompt') return fail(promptNotFound);
      if (result.status !== 'resumed') return conflict(result.status);

      return threadFrom(result.thread);
    },

    rewind: async (id, promptId, prompt) => {
      identifier(id);
      const target = identifier(promptId);
      const text = promptText(prompt);
      const checked = threadId(id);

      if (!isUuid(target)) {
        return fail('A prompt ID and a non-empty prompt are required.');
      }

      const result = await host((threads) =>
        threads.rewind({ id: checked, promptId: target, prompt: text }),
      );

      if (result.status === 'missing') return fail(notFound);
      if (result.status === 'unknown_prompt') return fail(promptNotFound);
      if (result.status === 'busy') {
        return fail(
          'The Thread is running or has queued input and cannot be rewound.',
        );
      }
      if (result.status !== 'accepted') return conflict('inactive');

      return receiptFrom(result.promptId);
    },

    interrupt: async (id, promptId) => {
      identifier(id);
      const target = identifier(promptId);
      const checked = threadId(id);

      if (!isUuid(target)) return fail(promptIdRequired);

      // The host's stop ignores `promptId`, as the REST route always did.
      const result = await host((threads) =>
        threads.pause({ id: checked, promptId: target }),
      );

      if (result === 'missing') return fail(notFound);
      if (result !== 'interrupted') return conflict(result);
    },

    queue: async (id) => {
      const checked = threadId(id);
      const queue = await host((threads) => threads.queue(checked));

      return queue === undefined ? fail(notFound) : (queue as ThreadQueue);
    },

    queuedPrompt: async (id, promptId) => {
      identifier(id);
      const target = identifier(promptId);
      const checked = threadId(id);

      if (!isUuid(target)) return fail(promptIdRequired);

      const prompt = await host((threads) =>
        threads.queuedPrompt({ id: checked, promptId: target }),
      );

      return prompt === undefined
        ? fail('This prompt is no longer queued.')
        : prompt;
    },

    editQueued: async (id, promptId, text, revision) => {
      if (
        typeof revision !== 'number' ||
        !Number.isSafeInteger(revision) ||
        revision < 0
      ) {
        return fail('Invalid prompt revision.');
      }

      identifier(id);
      const target = identifier(promptId);
      const words = promptText(text);
      const checked = threadId(id);

      if (!isUuid(target)) {
        return fail(
          'A prompt ID, non-empty text and its revision are required.',
        );
      }

      const result = await host((threads) =>
        threads.editQueued({
          id: checked,
          promptId: target,
          text: words,
          revision,
        }),
      );

      if (result.status === 'updated') return result.prompt;

      return fail(
        result.status === 'conflict'
          ? 'This prompt was edited elsewhere. Your changes have not been saved.'
          : result.status === 'not_editable'
            ? 'Only your prompts that have not started can be edited. Your changes have not been saved.'
            : 'This prompt is no longer available for editing. Your changes have not been saved.',
      );
    },

    removeQueued: async (id, promptId) => {
      identifier(id);
      const target = identifier(promptId);
      const checked = threadId(id);

      if (!isUuid(target)) return fail(promptIdRequired);

      const result = await host((threads) =>
        threads.removeQueued({ id: checked, promptId: target }),
      );

      if (result === 'missing') return fail(notFound);
      if (result !== 'removed') return conflict(result);
    },

    resumeQueue: async (id) => {
      const checked = threadId(id);
      const result = await host((threads) => threads.resumeQueue(checked));

      if (result.status === 'missing') return fail(notFound);
      if (result.status !== 'resumed') return conflict(result.status);

      return threadFrom(result.thread);
    },
  };
};

/** The adapter over the chat's activation services. */
export const threadsApi: ChatThreadsApi = createThreadsApi({
  threads: () => chatServices().use(RuntimeThreadsV1),
  history: currentHistory,
});
