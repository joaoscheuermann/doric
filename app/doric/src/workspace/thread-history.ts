import {
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

import type { Thread } from './api';
import type { ThreadEvent, ThreadUpdate } from './events';

/** One Thread's cached history as a caller reads it. */
export type ThreadHistory = {
  readonly thread: Thread | null;
  /** The highest sequence the cache holds: where a subscription resumes. */
  readonly lastSequence: number;
  readonly events: readonly ThreadEvent[];
};

/**
 * A best-effort local snapshot of each Thread's durable event log.
 *
 * PostgreSQL Thread events remain the sole conversation-history source; this
 * cache only lets a conversation render instantly when a Thread opens, and the
 * event stream reconciles it afterwards. Absorbing an update never blocks or
 * reorders what the stream forwards, reads never throw, and writes are
 * debounced to the configured directory, one JSON file per Thread.
 */
export type ThreadHistoryStore = {
  /** Absorbs one forwarded update into the cached snapshot. */
  absorb(update: ThreadUpdate): void;
  /** The cached snapshot for one Thread, or `null` when there is none. */
  read(threadId: string): ThreadHistory | null;
  /** Writes everything pending now. */
  flush(): void;
};

/** How many Thread snapshots the cache keeps before the oldest is deleted. */
export const snapshotLimit = 20;

/** How long absorbed updates wait before the cache is written. */
const writeDelayMs = 250;

/** What the cache holds for one Thread. */
type HeldHistory = {
  readonly threadId: string;
  readonly thread: Thread | null;
  readonly events: readonly ThreadEvent[];
};

/** What one file holds: the history plus its identity and save time. */
type SavedHistory = HeldHistory & {
  readonly lastSequence: number;
  readonly savedAt: string;
};

const record = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

const isThreadEvent = (value: unknown): value is ThreadEvent => {
  const entry = record(value);
  return (
    entry !== undefined &&
    typeof entry.projectId === 'string' &&
    typeof entry.threadId === 'string' &&
    typeof entry.promptId === 'string' &&
    typeof entry.sequence === 'number' &&
    Number.isSafeInteger(entry.sequence) &&
    entry.sequence >= 0 &&
    typeof entry.type === 'string' &&
    typeof entry.createdAt === 'string'
  );
};

/** A file that does not hold a snapshot reads as no snapshot at all. */
const historyFrom = (value: unknown): HeldHistory | null => {
  const saved = record(value);
  const events = saved?.events;
  const thread = saved?.thread;
  if (
    saved === undefined ||
    typeof saved.threadId !== 'string' ||
    typeof saved.lastSequence !== 'number' ||
    !Array.isArray(events) ||
    !events.every(isThreadEvent) ||
    (thread !== null && record(thread) === undefined)
  ) {
    return null;
  }
  return {
    threadId: saved.threadId,
    thread: thread as Thread | null,
    events: events as readonly ThreadEvent[],
  };
};

type Truncation = {
  readonly afterSequence: number;
  readonly sequence: number;
};

/**
 * A rewind marker names the last surviving sequence in its payload and its own
 * place in the log; the discarded range sits strictly between the two.
 */
const truncation = (event: ThreadEvent): Truncation | undefined => {
  const payload = record(event.event);
  if (payload?.type !== 'history.truncated') return undefined;
  const afterSequence = payload.afterSequence;
  if (
    typeof afterSequence !== 'number' ||
    !Number.isSafeInteger(afterSequence) ||
    afterSequence < 0
  ) {
    return undefined;
  }
  return { afterSequence, sequence: event.sequence };
};

/**
 * Drops held events a rewind already discarded — the same rule the renderer's
 * projector applies, so the cached log stays equal to what a full replay of the
 * durable log would produce.
 */
const survivors = (events: readonly ThreadEvent[]): readonly ThreadEvent[] => {
  const markers = events.flatMap((event) => truncation(event) ?? []);
  if (markers.length === 0) return events;
  return events.filter((event) =>
    markers.every(
      ({ afterSequence, sequence }) =>
        !(event.sequence > afterSequence && event.sequence < sequence),
    ),
  );
};

/** Whether every incoming event simply continues the held log. */
const follows = (
  held: readonly ThreadEvent[],
  incoming: readonly ThreadEvent[],
): boolean => {
  let last = held.at(-1)?.sequence ?? -1;
  for (const event of incoming) {
    if (!Number.isSafeInteger(event.sequence) || event.sequence <= last) {
      return false;
    }
    last = event.sequence;
  }
  return true;
};

/**
 * The merge rule: one log deduplicated by `sequence`, ascending, with anything
 * a rewind marker discarded dropped. A batch that simply continues the log
 * needs no map or sort; anything else merges in full.
 */
const merge = (
  held: readonly ThreadEvent[],
  incoming: readonly ThreadEvent[],
): readonly ThreadEvent[] => {
  if (!incoming.some((event) => truncation(event) !== undefined)) {
    if (follows(held, incoming)) return [...held, ...incoming];
  }
  const bySequence = new Map<number, ThreadEvent>();
  for (const event of [...held, ...incoming]) {
    if (!bySequence.has(event.sequence)) bySequence.set(event.sequence, event);
  }
  return survivors(
    [...bySequence.values()].sort(
      (left, right) => left.sequence - right.sequence,
    ),
  );
};

const view = (history: HeldHistory): ThreadHistory => ({
  thread: history.thread,
  lastSequence: history.events.at(-1)?.sequence ?? 0,
  events: history.events,
});

/** One cached Thread: its history, whether it has been read yet, and whether
 * the file behind it needs writing. */
type Entry = {
  history: HeldHistory | null;
  loaded: boolean;
  dirty: boolean;
};

/**
 * The snapshot store over one directory. Nothing it does throws: absorbing and
 * flushing are fire-and-forget for the event stream, and a read of a missing or
 * corrupt file answers `null`.
 */
export const createThreadHistoryStore = (
  directory: string,
): ThreadHistoryStore => {
  /** Recency order: the least recently updated Thread is the first entry. */
  const entries = new Map<string, Entry>();
  let writeTimer: ReturnType<typeof setTimeout> | undefined;

  const file = (threadId: string): string =>
    join(directory, `${encodeURIComponent(threadId)}.json`);

  const load = (threadId: string): HeldHistory | null => {
    try {
      return historyFrom(JSON.parse(readFileSync(file(threadId), 'utf8')));
    } catch {
      return null;
    }
  };

  const deleteFile = (threadId: string): void => {
    try {
      rmSync(file(threadId), { force: true });
    } catch {
      // A snapshot the cache cannot delete is one a later write replaces.
    }
  };

  const write = (threadId: string, history: HeldHistory): void => {
    const target = file(threadId);
    const saved: SavedHistory = {
      threadId,
      thread: history.thread,
      lastSequence: history.events.at(-1)?.sequence ?? 0,
      events: history.events,
      savedAt: new Date().toISOString(),
    };
    const temporary = `${target}.tmp`;
    writeFileSync(temporary, JSON.stringify(saved));
    renameSync(temporary, target);
  };

  const flush = (): void => {
    if (writeTimer !== undefined) {
      clearTimeout(writeTimer);
      writeTimer = undefined;
    }
    for (const [threadId, entry] of entries) {
      if (!entry.dirty || entry.history === null) continue;
      try {
        write(threadId, entry.history);
        entry.dirty = false;
      } catch {
        // Best-effort: a snapshot that cannot be written stays dirty and is
        // tried again on the next flush.
      }
    }
  };

  const scheduleWrite = (): void => {
    if (writeTimer !== undefined) return;
    writeTimer = setTimeout(() => {
      writeTimer = undefined;
      flush();
    }, writeDelayMs);
  };

  const evict = (): void => {
    while (entries.size > snapshotLimit) {
      const oldest = entries.keys().next().value;
      if (oldest === undefined) return;
      entries.delete(oldest);
      deleteFile(oldest);
    }
  };

  /** The entry for an update, read from disk once and made most recent. */
  const entryFor = (threadId: string): Entry => {
    const known = entries.get(threadId);
    if (known !== undefined) entries.delete(threadId);
    const entry = known ?? { history: null, loaded: false, dirty: false };
    entries.set(threadId, entry);
    if (!entry.loaded) {
      entry.history = load(threadId);
      entry.loaded = true;
    }
    return entry;
  };

  // Every file the directory already holds, oldest first, so the bound also
  // holds across app restarts and a fresh run evicts what a previous one left.
  try {
    mkdirSync(directory, { recursive: true });
    const held = readdirSync(directory).flatMap((name) => {
      if (!name.endsWith('.json')) return [];
      try {
        return [
          {
            threadId: decodeURIComponent(name.slice(0, -'.json'.length)),
            modified: statSync(join(directory, name)).mtimeMs,
          },
        ];
      } catch {
        return [];
      }
    });
    held.sort(
      (left, right) =>
        left.modified - right.modified ||
        left.threadId.localeCompare(right.threadId),
    );
    for (const { threadId } of held) {
      entries.set(threadId, { history: null, loaded: false, dirty: false });
    }
  } catch {
    // A directory the cache cannot index starts empty; reads stay tolerant.
  }

  return {
    absorb: (update) => {
      if (update.kind === 'error') return;
      if (update.kind === 'deleted') {
        entries.delete(update.threadId);
        deleteFile(update.threadId);
        return;
      }
      const threadId =
        update.kind === 'snapshot'
          ? update.snapshot.threadId
          : update.kind === 'event'
            ? update.event.threadId
            : update.thread.id;
      const entry = entryFor(threadId);
      const held: HeldHistory = entry.history ?? {
        threadId,
        thread: null,
        events: [],
      };
      entry.history =
        update.kind === 'snapshot'
          ? {
              threadId,
              thread: update.snapshot.thread ?? held.thread,
              events: merge(held.events, update.snapshot.events),
            }
          : update.kind === 'event'
            ? {
                threadId,
                thread: held.thread,
                events: merge(held.events, [update.event]),
              }
            : { threadId, thread: update.thread, events: held.events };
      entry.dirty = true;
      evict();
      scheduleWrite();
    },
    read: (threadId) => {
      const entry = entries.get(threadId);
      if (entry === undefined) {
        const held = load(threadId);
        return held === null ? null : view(held);
      }
      if (!entry.loaded) {
        entry.history = load(threadId);
        entry.loaded = true;
      }
      return entry.history === null ? null : view(entry.history);
    },
    flush,
  };
};
