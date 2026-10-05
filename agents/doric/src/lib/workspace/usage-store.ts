import type { Database } from '../database.js';
import { json } from './storage.js';
import {
  addTotals,
  emptyTotals,
  emptyUsage,
  projectUsage,
  type ThreadUsage,
  type UsageState,
  usageTotals,
} from './usage.js';

type Store = Pick<Database, 'thread' | 'threadEvent'>;
const eventTypes = ['response.started', 'usage', 'response.finished'];

/** Older Threads are projected once from the usage already in their event log. */
export const readUsageState = async (
  store: Store,
  id: string,
  stored: unknown,
): Promise<UsageState> => {
  if (stored !== null && stored !== undefined) return stored as UsageState;
  const events = await store.threadEvent.findMany({
    where: { threadId: id, type: { in: eventTypes } },
    orderBy: { sequence: 'asc' },
    select: { event: true },
  });
  return events.reduce(
    (state, entry) => projectUsage(state, entry.event),
    emptyUsage,
  );
};

/** Called under the same Thread row lock and transaction as the durable event. */
export const writeUsage = async (
  store: Store,
  id: string,
  type: string,
  value: unknown,
  stored: unknown,
): Promise<void> => {
  if (!eventTypes.includes(type)) return;
  const state = await readUsageState(store, id, stored);
  await store.thread.update({
    where: { id },
    data: { usage: json(projectUsage(state, value)) },
    select: { id: true },
  });
};

/** A rewind changes context, but never refunds calls that have already run. */
export const rewindUsage = async (
  store: Store,
  id: string,
  previous: UsageState,
): Promise<void> => {
  const retained = await readUsageState(store, id, null);
  await store.thread.update({
    where: { id },
    data: {
      usage: json({
        completed: usageTotals(previous),
        ...(retained.context === undefined
          ? {}
          : { context: retained.context }),
      }),
    },
    select: { id: true },
  });
};

/** Includes descendants even when no desktop client has opened their logs. */
export const readThreadUsage = async (
  database: Database,
  id: string,
): Promise<ThreadUsage | undefined> => {
  const rows = await database.$queryRaw<
    {
      id: string;
      name: string;
      parentThreadId: string | null;
      usage: unknown;
    }[]
  >`
    WITH RECURSIVE subtree AS (
      SELECT id, name, parent_thread_id, usage FROM thread WHERE id = ${id}::uuid
      UNION ALL
      SELECT t.id, t.name, t.parent_thread_id, t.usage FROM thread t
      JOIN subtree s ON t.parent_thread_id = s.id
    ) SELECT id, name, parent_thread_id AS "parentThreadId", usage FROM subtree`;
  if (rows.length === 0) return undefined;
  const states = await Promise.all(
    rows.map((row) => readUsageState(database, row.id, row.usage)),
  );
  const context = states[rows.findIndex((row) => row.id === id)]?.context;
  const threads = rows.map((row, index) => ({
    threadId: row.id,
    name: row.name,
    ...(row.parentThreadId === null
      ? {}
      : { parentThreadId: row.parentThreadId }),
    ...usageTotals(states[index] ?? emptyUsage),
  }));
  return {
    ...(context === undefined ? {} : { context }),
    total: threads.reduce(addTotals, emptyTotals),
    threads,
  };
};
