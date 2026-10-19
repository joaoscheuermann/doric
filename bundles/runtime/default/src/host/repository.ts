import type { Call } from 'bundle/contracts';
import { type RuntimeThreads, readRuntimeScope } from 'runtime/contracts';

import { repositoryPrompt } from './prompts/repository.js';

/** The runtime's Thread reads, while some bundle provides them. */
export type ThreadReads = () => Pick<RuntimeThreads, 'thread'> | undefined;

/**
 * The `onBeforeModelRequestHook` handler that adds the coding workflow while
 * the prompt's Thread works at a repository root. The runtime records that as
 * the Thread's `cwdRepo` hint whenever its working directory moves and after
 * each job, so the topic follows a `cwd` move from the next model request.
 * Without the runtime's reads, the system prompt stays as it is.
 */
export const repositoryTopic =
  (threads: ThreadReads) =>
  async (
    { system }: { readonly system: string },
    call: Call,
  ): Promise<{ readonly system: string }> => {
    const { threadId } = readRuntimeScope(call);
    const thread =
      threadId === undefined
        ? undefined
        : await threads()?.thread(threadId, call);

    return thread?.cwdRepo === undefined
      ? { system }
      : { system: `${system}\n\n${repositoryPrompt}` };
  };
