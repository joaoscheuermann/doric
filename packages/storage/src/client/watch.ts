/**
 * The iterations of `Storage.watch` (spec "The storage contract", "Watch"):
 * the `StorageChange`s of one `Watch` call, or the refusal of a request the
 * client checked before any call.
 */
import { ConnectError } from '@connectrpc/connect';
import type { CallArg } from 'bundle/contracts';
import type { WatchResponse } from 'bundle/contracts/gen/doric/storage/v2/storage_pb.js';

import { clientFailure } from '../rpc/call.js';
import type { StorageChange } from './types.js';

/** An iteration that rejects with `error` at its first step. */
export const failed = (error: unknown): AsyncIterable<never> => ({
  [Symbol.asyncIterator]: () => ({ next: () => Promise.reject(error) }),
});

/**
 * The `StorageChange`s of `responses`, a `Watch` call made for `call`, as
 * plain objects in the order the engine sent them: a `ConnectError` while
 * iterating rejects as its `ContractError` (`clientFailure`), any other
 * error as it is. Ending the iteration ends the call.
 */
export const changesOf = async function* (
  responses: AsyncIterable<WatchResponse>,
  call: CallArg | undefined,
): AsyncGenerator<StorageChange> {
  try {
    for await (const { position, documents, streams } of responses) {
      yield {
        position,
        documents: documents.map(({ type, id, revision, deleted }) => ({
          type,
          id,
          revision,
          deleted,
        })),
        streams: streams.map(({ stream, lastSequence }) => ({
          stream,
          lastSequence,
        })),
      };
    }
  } catch (error) {
    throw error instanceof ConnectError ? clientFailure(error, call) : error;
  }
};
