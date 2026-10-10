import {
  isContractError,
  type Storage,
  type StreamEntry,
  type ThreadEventEnvelope,
} from 'bundle/contracts';

import type { ThreadEvent } from '../../contracts/model.js';
import { threadEventsStream } from '../../contracts/storage.js';
import { checkLimit } from './records.js';

/*
 * A Thread's event log on its stream `runtime.thread.events/<threadId>`.
 * Each entry's value is the stage-2 thread envelope; the sequence and
 * `createdAt` are the protocol entry's (the backend's commit time, as
 * `thread_event.created_at` was the transaction's).
 */

/** Entries read per page when a whole log is read. */
const pageSize = 500;

/** The durable `type` of an event: its own `type`, else `unknown`. */
export const eventType = (value: unknown): string =>
  typeof value === 'object' &&
  value !== null &&
  'type' in value &&
  typeof value.type === 'string'
    ? value.type
    : 'unknown';

export const toThreadEvent = (entry: StreamEntry): ThreadEvent => {
  const value = entry.value as ThreadEventEnvelope;
  return {
    projectId: value.projectId,
    threadId: value.threadId,
    promptId: value.promptId,
    sequence: entry.sequence,
    type: value.type,
    event: value.event,
    createdAt: entry.createdAt,
  };
};

/**
 * One page after `afterSequence`. A cursor past the stream's counter has no
 * entries (the protocol refuses that read), like a query past the last row.
 */
const readPage = async (
  storage: Storage,
  threadId: string,
  afterSequence: number,
  limit: number,
): Promise<{ readonly entries: StreamEntry[]; readonly last: number }> => {
  try {
    const page = await storage.read({
      stream: threadEventsStream(threadId),
      afterSequence,
      limit,
    });
    return { entries: page.entries, last: page.lastSequence };
  } catch (error) {
    if (isContractError(error) && error.code === 'invalid_input')
      return { entries: [], last: afterSequence };
    throw error;
  }
};

/** A `sequence > n` bound as the protocol's non-negative integer cursor. */
const cursorOf = (sequence: number): number =>
  Number.isFinite(sequence) ? Math.max(0, Math.floor(sequence)) : 0;

/** Every entry after `sequence`, in order. */
export const entriesAfter = async (
  storage: Storage,
  threadId: string,
  sequence: number,
): Promise<StreamEntry[]> => {
  if (sequence === Number.POSITIVE_INFINITY) return [];
  const entries: StreamEntry[] = [];
  let after = cursorOf(sequence);
  for (;;) {
    const page = await readPage(storage, threadId, after, pageSize);
    entries.push(...page.entries);
    const last = page.entries.at(-1);
    if (last === undefined || last.sequence >= page.last) return entries;
    after = last.sequence;
  }
};

export const eventsAfter = async (
  storage: Storage,
  threadId: string,
  sequence: number,
): Promise<readonly ThreadEvent[]> =>
  (await entriesAfter(storage, threadId, sequence)).map(toThreadEvent);

export const eventsAfterPage = async (
  storage: Storage,
  threadId: string,
  sequence: number,
  limit: number,
): Promise<{
  readonly events: readonly ThreadEvent[];
  readonly nextSequence?: number;
}> => {
  checkLimit(limit);
  if (sequence === Number.POSITIVE_INFINITY) return { events: [] };
  const rows: StreamEntry[] = [];
  let after = cursorOf(sequence);
  // limit + 1 entries say whether another page exists, as `take` did.
  while (rows.length < limit + 1) {
    const page = await readPage(
      storage,
      threadId,
      after,
      Math.min(1000, limit + 1 - rows.length),
    );
    rows.push(...page.entries);
    const last = page.entries.at(-1);
    if (last === undefined || last.sequence >= page.last) break;
    after = last.sequence;
  }
  const events = rows.slice(0, limit).map(toThreadEvent);
  const last = events.at(-1);
  return {
    events,
    ...(rows.length > limit && last !== undefined
      ? { nextSequence: last.sequence }
      : {}),
  };
};
