// Dev-only: the durable Thread event log the fake host keeps in memory.
//
// The real host writes one row per appended event into the Thread's stream
// (`runtime.thread.events/{threadId}`, `bundles/runtime/runtime/src/contracts/events.ts`)
// and the protocol entry carries the sequence and the time; the row itself is
// `{ projectId, threadId, promptId, type, event }`, with the event body the
// registered payload plus its `type` (`bundles/foundation/core/src/host/events/facade.ts`
// builds it as `{ type, ...payload }`). This module keeps exactly that shape in
// memory, so `runtime.threads/v1.watchThread` replays a real log instead of an
// empty snapshot.
//
// One counter per Thread, starting at 1, and the Thread record's
// `lastSequence` follows it, as the store's document does
// (`bundles/runtime/runtime/src/contracts/storage.ts`).

/** One row of a Thread's log, as the desktop's `ThreadEvent` reads it. */
export const createThreadLog = ({
  workspace,
  log,
  now = () => new Date().toISOString(),
}) => {
  /** threadId → the rows, in sequence order. */
  const entries = new Map();
  /** threadId → the live watch sinks of this Thread. */
  const watchers = new Map();
  /** threadId → the promptId new events of this Thread belong to. */
  const prompts = new Map();

  const eventsOf = (threadId) => entries.get(threadId) ?? [];
  const lastSequence = (threadId) => eventsOf(threadId).at(-1)?.sequence ?? 0;
  const promptIdOf = (threadId) => prompts.get(threadId);
  const setPromptId = (threadId, promptId) => prompts.set(threadId, promptId);

  const watch = (threadId, listener) => {
    const sinks = watchers.get(threadId) ?? new Set();

    sinks.add(listener);
    watchers.set(threadId, sinks);

    return () => {
      sinks.delete(listener);
      if (sinks.size === 0) watchers.delete(threadId);
    };
  };

  const publish = (threadId, record) => {
    for (const listener of watchers.get(threadId) ?? []) {
      try {
        listener.push(record);
      } catch (error) {
        // A watch that cannot take an item is already gone: the fake host has
        // nowhere to report it, so it says so and keeps the log.
        log.note(
          `a watch of Thread ${threadId} refused event ${record.sequence}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
  };

  /**
   * Appends one row to a Thread's log: the next sequence, the row itself and
   * the Thread record's `lastSequence`, then every open watch.
   */
  const append = ({ projectId, threadId, promptId, type, event }) => {
    const rows = entries.get(threadId) ?? [];
    const record = {
      projectId,
      threadId,
      promptId,
      sequence: rows.length + 1,
      type,
      event,
      createdAt: now(),
    };

    rows.push(record);
    entries.set(threadId, rows);

    if (typeof promptId === 'string') prompts.set(threadId, promptId);

    const thread = workspace.threadById(threadId);

    if (thread !== undefined) {
      thread.lastSequence = record.sequence;
      thread.updatedAt = record.createdAt;
    }

    publish(threadId, record);

    return record;
  };

  /** Appends each `{ type, event }` of a Thread, in order, under one prompt. */
  const appendMany = ({ projectId, threadId, promptId, values }) =>
    values.map(({ type, event }) =>
      append({ projectId, threadId, promptId, type, event }),
    );

  return {
    append,
    appendMany,
    eventsOf,
    lastSequence,
    promptIdOf,
    setPromptId,
    watch,
    /** How many rows the log of every Thread holds: the seeding report. */
    counts: () =>
      Object.fromEntries([...entries].map(([id, rows]) => [id, rows.length])),
  };
};
