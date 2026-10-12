import type { CommitBatch, Storage } from 'bundle/contracts';

import type { HistoryPatch, HistoryReader } from '../../contracts/executor.js';
import {
  type HistoryDocument,
  historyDocumentId,
  historyType,
} from '../../contracts/storage.js';
import { queryAll } from './documents.js';
import { storableJson } from './records.js';

/*
 * The executor's opaque, versioned Thread state (`runtime.history/v1`): one
 * document per named part, `<threadId>:<part>`. It replaces the former
 * `thread.messages` and `thread.checkpoints` columns; the store never reads
 * a part's value, it only keeps it.
 */

const type = historyType.type;

/** Every history part of a Thread. */
export const historyParts = (
  storage: Storage,
  threadId: string,
): Promise<{ readonly type: string; readonly id: string }[]> =>
  queryAll(storage, { type, index: 'byThread', equals: [threadId] }).then(
    (items) => items.map(({ id }) => ({ type, id })),
  );

/**
 * A reader of the Thread's state. `format` is the format of the stored
 * parts when the reader was opened; every `read` sees the part as it is
 * stored now.
 */
export const historyReader = async (
  storage: Storage,
  threadId: string,
): Promise<HistoryReader> => {
  const [first] = (
    await storage.query({
      type,
      index: 'byThread',
      equals: [threadId],
      limit: 1,
    })
  ).items;
  const format = (first?.value as HistoryDocument | undefined)?.format;
  return {
    format,
    read: async (part) => {
      const stored = await storage.get({
        type,
        id: historyDocumentId(threadId, part),
      });
      return (stored?.value as HistoryDocument | undefined)?.value;
    },
  };
};

/** The puts that write a patch, each value made storable. */
export const historyPuts = (
  threadId: string,
  projectId: string,
  patch: HistoryPatch,
): NonNullable<CommitBatch['put']> =>
  Object.entries(patch.parts).map(([part, value]) => ({
    type,
    id: historyDocumentId(threadId, part),
    value: {
      threadId,
      projectId,
      format: patch.format,
      part,
      value: storableJson(value),
    } satisfies HistoryDocument,
  }));
