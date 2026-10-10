// Public contracts of the `history` bundle: the desktop's local per-Thread
// history snapshots. The schemas are loose on purpose (stage 9 design §8):
// they name only the fields the cache reads and keep every other field, so
// this bundle does not depend on the runtime's contracts.

import { type CallArg, ref } from 'bundle/contracts';
import { z } from 'zod';

/** A Thread record as the host sends it; the cache reads only `id`. */
export const threadRecordSchema = z.looseObject({ id: z.string() });

export type ThreadRecord = z.output<typeof threadRecordSchema>;

/** One durable Thread event as the host sends it. */
export const threadEventRecordSchema = z.looseObject({
  projectId: z.string(),
  threadId: z.string(),
  promptId: z.string(),
  sequence: z.number().int().nonnegative(),
  type: z.string(),
  createdAt: z.string(),
});

export type ThreadEventRecord = z.output<typeof threadEventRecordSchema>;

/** One Thread's cached history. */
export const historySnapshotSchema = z
  .object({
    thread: threadRecordSchema.nullable(),
    /** The highest cached sequence (0 without events): where a watch resumes. */
    lastSequence: z.number().int().nonnegative(),
    events: z.array(threadEventRecordSchema),
  })
  .strict();

export type HistorySnapshot = z.output<typeof historySnapshotSchema>;

/** One update the chat received from the host, in the order it applied them. */
export const historyUpdateSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('snapshot'),
      thread: threadRecordSchema.nullable(),
      events: z.array(threadEventRecordSchema),
    })
    .strict(),
  z
    .object({ kind: z.literal('event'), event: threadEventRecordSchema })
    .strict(),
  z.object({ kind: z.literal('updated'), thread: threadRecordSchema }).strict(),
  z
    .object({
      kind: z.literal('deleted'),
      projectId: z.string(),
      threadId: z.string(),
    })
    .strict(),
]);

export type HistoryUpdate = z.output<typeof historyUpdateSchema>;

export const historyWriteSchema = z
  .object({
    threadId: z.string(),
    updates: z.array(historyUpdateSchema),
  })
  .strict();

export type HistoryWrite = z.output<typeof historyWriteSchema>;

/**
 * `history.snapshots/v1` (desktopMain): a best-effort cache that lets a
 * conversation render before the host answers. `read` answers `null` for a
 * Thread without a usable snapshot; `write` absorbs updates and saves them
 * later (debounced).
 */
export interface HistorySnapshots {
  read(threadId: string, call?: CallArg): Promise<HistorySnapshot | null>;
  write(input: HistoryWrite, call?: CallArg): Promise<void>;
}

export const HistorySnapshotsV1 = ref<HistorySnapshots>('history.snapshots/v1');

export const historySnapshotsMethods = {
  read: { input: z.string(), output: historySnapshotSchema.nullable() },
  write: { input: historyWriteSchema, output: z.void() },
} as const;
