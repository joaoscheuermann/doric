// `runtime.attachments/v1` over the router (phase 3, slice S46a): `Attach`
// client streaming, `Read` server streaming.

import type { ServiceImpl } from '@connectrpc/connect';
import { type Call, ContractError, callOf } from 'bundle/contracts';
import { chunkBytes, joinChunks } from 'storage/rpc';

import {
  ATTACHMENT_MAX_BYTES,
  attachmentsScopeMessage,
  attachScopeMessage,
  runtimeAttachmentsMethods as methods,
} from '../../contracts/attachments.js';
import {
  type AttachmentsService,
  AttachResponseSchema,
  ReadResponseSchema,
} from '../../contracts/gen/doric/runtime/attachments/v1/attachments_pb.js';
import { readRuntimeScope } from '../../contracts/scope.js';
import type { RuntimeCore } from '../core.js';
import type { AttachmentStore } from '../store/attachments.js';
import { encode } from './codec.js';
import { detached, parseInput, routed } from './errors.js';
import { routedItems } from './streams.js';

/** The core's attachment store; `unavailable` when it holds none. */
const storeOf = ({ attachments }: RuntimeCore): AttachmentStore => {
  if (attachments === undefined)
    throw new ContractError('unavailable', 'runtime holds no attachments.');
  return attachments;
};

/**
 * `runtime.attachments/v1` over `RuntimeCore`. `core()` throws
 * `ContractError('unavailable')` before `activate`.
 */
export const routedAttachmentsService = (
  core: () => RuntimeCore,
): ServiceImpl<typeof AttachmentsService> => {
  /** The Thread of the scope, which a Thread scope names through its record. */
  const threadOf = async (runtime: RuntimeCore, call: Call) => {
    const { threadId } = readRuntimeScope(call);
    if (threadId === undefined) return undefined;
    const thread = await runtime.threads.record(threadId);
    if (thread === undefined)
      throw new ContractError(
        'not_found',
        `Thread ${threadId} does not exist.`,
      );
    return thread;
  };

  /** The Project whose images the call reads. */
  const projectOf = async (runtime: RuntimeCore, call: Call) => {
    const thread = await threadOf(runtime, call);
    if (thread !== undefined) return thread.projectId;
    const { projectId } = readRuntimeScope(call);
    if (projectId !== undefined) return projectId;
    throw new ContractError('invalid_input', attachmentsScopeMessage);
  };

  return {
    attach: (requests, context) =>
      routed(async () => {
        const runtime = core();
        const attachments = storeOf(runtime);
        const call = callOf(context);
        // An image belongs to the Thread it was attached in, and goes with it.
        const thread = await threadOf(runtime, call);
        if (thread === undefined)
          throw new ContractError('invalid_input', attachScopeMessage);

        let name: string | undefined;
        const chunks: Uint8Array[] = [];
        let size = 0;
        for await (const { item } of requests) {
          if (item.case === 'head') {
            if (name !== undefined)
              throw new ContractError(
                'invalid_input',
                'An attachment has one head, before its chunks.',
              );
            name = item.value.name;
          } else if (item.case === 'chunk') {
            if (name === undefined)
              throw new ContractError(
                'invalid_input',
                'An attachment starts with its head.',
              );
            size += item.value.length;
            if (size > ATTACHMENT_MAX_BYTES)
              throw new ContractError(
                'invalid_input',
                `An attachment is at most ${ATTACHMENT_MAX_BYTES} bytes.`,
              );
            chunks.push(item.value);
          }
        }
        if (name === undefined)
          throw new ContractError(
            'invalid_input',
            'An attachment starts with its head.',
          );

        const input = parseInput(
          'runtime.attachments/v1 attach',
          methods.attach.input,
          {
            name,
            bytes: Buffer.from(joinChunks(chunks)).toString('base64'),
          },
        );
        return encode(AttachResponseSchema, {
          attachment: await detached(() =>
            attachments.attach(
              { projectId: thread.projectId, threadId: thread.id },
              input,
              call,
            ),
          ),
        });
      }),
    read: (request, context) =>
      routedItems(async function* () {
        const runtime = core();
        const attachments = storeOf(runtime);
        const call = callOf(context);
        const { id } = parseInput(
          'runtime.attachments/v1 read',
          methods.read.input,
          {
            id: request.id,
          },
        );
        const content = await attachments.read(
          await projectOf(runtime, call),
          id,
          call,
        );
        if (content === undefined) {
          yield encode(ReadResponseSchema, { head: {} });
          return;
        }
        const { bytes, ...attachment } = content;
        yield encode(ReadResponseSchema, { head: { attachment } });
        for (const chunk of chunkBytes(Buffer.from(bytes, 'base64')))
          yield { item: { case: 'chunk' as const, value: chunk } };
      }),
  };
};
