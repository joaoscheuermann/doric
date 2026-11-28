// A `storage/v2` client over an in-memory Connect router whose `Commit`
// records the items it receives and answers position 1, so a test can see
// what the client sends without spawning the engine
// (`storage-client-items.test.ts`). Every other method answers
// `UNIMPLEMENTED`, as the router does for a method it has no handler for.

import type { DescFile } from '@bufbuild/protobuf';
import { createClient, createRouterTransport } from '@connectrpc/connect';
import {
  type CommitRequest,
  StorageService,
} from 'bundle/contracts/gen/doric/storage/v2/storage_pb.js';

import { storageOver } from '../../src/client/index.js';
import type { Storage } from '../../src/client/types.js';

/** A `Storage` over a recording router, and what its `Commit` received. */
export interface RecordingStorage {
  readonly storage: Storage;
  /** One entry per `Commit` call, in order: the items of its requests. */
  readonly commits: readonly (readonly CommitRequest['item'][])[];
}

/** `storageOver` the client of a fresh recording router, for `files`. */
export const recordingStorage = async (
  files: readonly DescFile[],
): Promise<RecordingStorage> => {
  const commits: CommitRequest['item'][][] = [];
  const transport = createRouterTransport((router) => {
    router.service(StorageService, {
      register: () => ({}),
      commit: async (requests) => {
        const items: CommitRequest['item'][] = [];

        commits.push(items);

        for await (const { item } of requests) {
          items.push(item);
        }

        return { position: 1 };
      },
    });
  });
  const storage = await storageOver(
    createClient(StorageService, transport),
    files,
  );

  return { storage, commits };
};
