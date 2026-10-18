import {
  type Call,
  ContractError,
  defineMethod,
  defineService,
} from 'bundle/contracts';

import {
  attachmentsScopeMessage,
  attachScopeMessage,
  runtimeAttachmentsMethods as methods,
  RuntimeAttachmentsV1,
} from '../../contracts/attachments.js';
import { readRuntimeScope } from '../../contracts/scope.js';
import type { AttachmentStore } from '../store/attachments.js';
import type { ThreadStore } from '../store/types.js';

/*
 * runtime.attachments/v1: the images of the calling Project. An image is
 * attached in a Thread and deleted with it; any Thread of the Project reads it,
 * so a reader attaching from a Thread and a tool running in a delegated Thread
 * reach the same images.
 */

export const attachmentsService = ({
  attachments,
  threads,
}: {
  readonly attachments: AttachmentStore;
  readonly threads: Pick<ThreadStore, 'record'>;
}) => {
  /** The Thread of the scope, which a Thread scope names through its record. */
  const threadOf = async (call: Call) => {
    const { threadId } = readRuntimeScope(call);
    if (threadId === undefined) return undefined;
    const thread = await threads.record(threadId);
    if (thread === undefined)
      throw new ContractError(
        'not_found',
        `Thread ${threadId} does not exist.`,
      );
    return thread;
  };

  /** The Project whose images the call reads. */
  const projectOf = async (call: Call): Promise<string> => {
    const thread = await threadOf(call);
    if (thread !== undefined) return thread.projectId;
    const { projectId } = readRuntimeScope(call);
    if (projectId !== undefined) return projectId;
    throw new ContractError('invalid_input', attachmentsScopeMessage);
  };

  return defineService(RuntimeAttachmentsV1, {
    attach: defineMethod({
      expose: 'desktop',
      ...methods.attach,
      execute: async (input, call) => {
        // An image belongs to the Thread it was attached in, and goes with it.
        const thread = await threadOf(call);
        if (thread === undefined)
          throw new ContractError('invalid_input', attachScopeMessage);
        return await attachments.attach(
          { projectId: thread.projectId, threadId: thread.id },
          input,
          call,
        );
      },
    }),
    read: defineMethod({
      expose: 'desktop',
      ...methods.read,
      execute: async ({ id }, call) =>
        await attachments.read(await projectOf(call), id, call),
    }),
  });
};
