import {
  isEmptyDelta,
  mergeDeltas,
  type PromptSession,
  type StreamDelta,
  streamDelta,
} from 'runtime/contracts';

/*
 * The run's writes to its Thread, with the streamed deltas coalesced: the
 * log stores one event per run of same-kind deltas instead of one per token.
 * A run of deltas is held until a window has passed since its first delta,
 * until it reaches a size cap, or until anything else is written — a delta
 * that does not merge, any other event, a history save — and when the run
 * ends. Every write, a window's included, goes through one queue, so the log
 * keeps the order the run wrote in. What is held is never published, so a
 * crash loses at most one window that no reader ever saw.
 */

/** The window a held run of deltas waits at most, in milliseconds. */
export const deltaWindow = 250;

/** The size, in UTF-8 bytes of its text, past which a held run is written. */
const deltaLimit = 64 * 1024;

/** The timers the window runs on; the host's own by default. */
export interface Clock {
  setTimeout(task: () => void, delay: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface CoalescerOptions {
  readonly limit?: number;
  readonly clock?: Clock;
}

const hostClock: Clock = {
  setTimeout: (task, delay) => setTimeout(task, delay),
  clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout),
};

const textOf = (delta: StreamDelta): string =>
  delta.type === 'tool_call.delta' ? (delta.argumentsDelta ?? '') : delta.delta;

const bytesOf = (delta: StreamDelta): number =>
  Buffer.byteLength(textOf(delta), 'utf8');

/**
 * Wraps a run's session so its deltas are written coalesced. Any write that
 * is not a delta first writes what is held, so the run's last write — its
 * history, saved when it ends, aborts or throws — leaves nothing held. A write's
 * failure reaches the caller of that write; a window's failure, which no
 * caller awaits, reaches the next write instead, so the run still ends on the
 * runtime's own persistence error. A history save still runs before it
 * answers that failure, so the history the runtime retries is the latest.
 */
export const coalesced = (
  session: PromptSession,
  options: CoalescerOptions = {},
): PromptSession => {
  const limit = options.limit ?? deltaLimit;
  const clock = options.clock ?? hostClock;
  let held:
    | { delta: StreamDelta; bytes: number; readonly timer: unknown }
    | undefined;
  let owed: { readonly error: unknown } | undefined;
  let queue: Promise<void> = Promise.resolve();

  /** Runs `task` in order; `saves` runs it even when a failure is owed. */
  const enqueue = (task: () => Promise<void>, saves = false): Promise<void> => {
    const next = queue.then(async () => {
      const debt = owed;
      owed = undefined;
      if (debt !== undefined && !saves) throw debt.error;
      await task();
      if (debt !== undefined) throw debt.error;
    });
    queue = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  };

  const write = async (): Promise<void> => {
    if (held === undefined) return;
    const { delta, timer } = held;
    held = undefined;
    clock.clearTimeout(timer);
    await session.record({ event: delta });
  };

  const hold = (delta: StreamDelta, bytes: number): void => {
    const current = {
      delta,
      bytes,
      timer: clock.setTimeout(() => {
        void enqueue(async () => {
          // A window that fired after its run was written holds nothing.
          if (held !== current) return;
          try {
            await write();
          } catch (error) {
            owed = { error };
          }
        });
      }, deltaWindow),
    };
    held = current;
  };

  const add = async (delta: StreamDelta): Promise<void> => {
    if (isEmptyDelta(delta)) return;
    const bytes = bytesOf(delta);
    const merged =
      held !== undefined && held.bytes + bytes <= limit
        ? mergeDeltas(held.delta, delta)
        : undefined;
    if (held !== undefined && merged !== undefined) {
      held.delta = merged;
      held.bytes += bytes;
    } else {
      await write();
      hold(delta, bytes);
    }
    if (held !== undefined && held.bytes >= limit) await write();
  };

  return {
    history: session.history,
    record: (entry) =>
      enqueue(async () => {
        const delta =
          entry.history === undefined ? streamDelta(entry.event) : undefined;
        if (delta !== undefined) return add(delta);
        await write();
        await session.record(entry);
      }, entry.history !== undefined),
    ...(session.steers === undefined
      ? {}
      : { steers: session.steers.bind(session) }),
    ...(session.attachment === undefined
      ? {}
      : { attachment: session.attachment.bind(session) }),
  };
};
