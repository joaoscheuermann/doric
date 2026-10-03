import type { Manager, Socket } from 'socket.io-client';

import type { Project, Thread } from './api';
import type { ThreadHistoryStore } from './thread-history';

export type ThreadEvent = {
  readonly projectId: string;
  readonly threadId: string;
  readonly promptId: string;
  readonly sequence: number;
  readonly type: string;
  readonly event: unknown;
  readonly createdAt: string;
};

export type ThreadSnapshot = {
  readonly threadId: string;
  readonly projectId: string | null;
  readonly project: Project | null;
  readonly thread: Thread | null;
  readonly events: readonly ThreadEvent[];
};

export type ThreadUpdate =
  | { readonly kind: 'snapshot'; readonly snapshot: ThreadSnapshot }
  | { readonly kind: 'event'; readonly event: ThreadEvent }
  | { readonly kind: 'updated'; readonly thread: Thread }
  | {
      readonly kind: 'deleted';
      readonly projectId: string;
      readonly threadId: string;
    }
  /**
   * A stream failure. It names the Thread of the watch that raised it, so the
   * window draws it in that Thread's conversation and in no other.
   */
  | {
      readonly kind: 'error';
      readonly threadId: string;
      readonly message: string;
    };

export type ThreadEventTarget = {
  once(event: 'destroyed', listener: () => void): void;
  off(event: 'destroyed', listener: () => void): void;
  isDestroyed(): boolean;
  send(channel: string, update: ThreadUpdate): void;
};

export type ThreadEventService = {
  /** Watches one Thread, replacing any watch already held for that Thread. */
  watch(
    target: ThreadEventTarget,
    threadId: string,
    afterSequence: number,
  ): void;
  /** Ends one Thread's watch, and only that one. */
  stop(target: ThreadEventTarget, threadId: string): void;
  /** Ends every watch one window holds, which is what its destruction does. */
  stopAll(target: ThreadEventTarget): void;
  /** Ends every watch, which is what app shutdown does. */
  close(): void;
};

export const threadUpdateChannel = 'doric:threads:update';

/** One connection, as a Thread watch opens and closes it. */
export type ThreadConnection = Pick<Manager, 'socket'>;

/**
 * Opens the connection one watched Thread holds. Every call builds a Manager of
 * its own, so the namespace socket opened on it is that connection's only one:
 * disconnecting that socket closes the Engine.IO connection itself, which is
 * what makes the host drop the Thread's subscription even when no namespace
 * DISCONNECT packet was ever delivered.
 */
export type ThreadConnectionFactory = () => ThreadConnection;

type Watch = {
  readonly target: ThreadEventTarget;
  readonly threadId: string;
  readonly socket: Socket;
  cursor: number;
};

const record = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : undefined;

const eventSequence = (value: unknown): number | undefined => {
  const sequence = record(value)?.sequence;
  return typeof sequence === 'number' &&
    Number.isSafeInteger(sequence) &&
    sequence >= 0
    ? sequence
    : undefined;
};

const errorMessage = (value: unknown): string => {
  const error = record(value);
  return typeof error?.code === 'string' &&
    error.code.length > 0 &&
    typeof error.message === 'string' &&
    error.message.length > 0
    ? error.message
    : 'The Thread event stream failed.';
};

/**
 * Watches every Thread one window has open, each on its own connection, while
 * retaining that Thread's durable cursor for reconnects, and absorbs every
 * forwarded update into the local snapshot cache. The cache is fire-and-forget:
 * it never delays, drops, or reorders what reaches the renderer, and it is
 * written when a watch stops or the app closes as well as on its own debounce.
 *
 * A watch forwards, and absorbs, only updates that name its own Thread, so an
 * update can never reach the window through a watch of another Thread. The
 * connection is the Thread's own, so ending the watch ends the host's
 * subscription with it.
 */
export const createThreadEventService = (
  connect: ThreadConnectionFactory,
  history: ThreadHistoryStore,
): ThreadEventService => {
  /** One live watch per watched Thread, each holding its own connection. */
  const watches = new Map<string, Watch>();
  /** One destroyed listener per window, however many Threads it watches. */
  const destroyed = new Map<ThreadEventTarget, () => void>();

  const flushHistory = (): void => {
    try {
      history.flush();
    } catch {
      // A cache failure is never a stream failure.
    }
  };

  const holdsWatches = (target: ThreadEventTarget): boolean =>
    [...watches.values()].some((watch) => watch.target === target);

  /** Forgets a window's destroyed listener once nothing of it is watched. */
  const forget = (target: ThreadEventTarget): void => {
    const listener = destroyed.get(target);
    if (listener === undefined || holdsWatches(target)) return;
    destroyed.delete(target);
    target.off('destroyed', listener);
  };

  /** Drops one watch's socket listeners and its own connection. */
  const release = (watch: Watch): void => {
    watches.delete(watch.threadId);
    watch.socket.removeAllListeners();
    watch.socket.disconnect();
  };

  /** Ends one watch: its connection, then its window's listener when idle. */
  const end = (watch: Watch): void => {
    release(watch);
    forget(watch.target);
    flushHistory();
  };

  const stop = (target: ThreadEventTarget, threadId: string): void => {
    const watch = watches.get(threadId);
    if (watch === undefined || watch.target !== target) return;
    end(watch);
  };

  const stopAll = (target: ThreadEventTarget): void => {
    for (const watch of [...watches.values()]) {
      if (watch.target === target) release(watch);
    }
    forget(target);
    flushHistory();
  };

  const send = (watch: Watch, update: ThreadUpdate): void => {
    if (watches.get(watch.threadId) !== watch || watch.target.isDestroyed())
      return;
    watch.target.send(threadUpdateChannel, update);
    try {
      history.absorb(update);
    } catch {
      // A cache failure is never a stream failure.
    }
  };

  return {
    watch: (target, threadId, afterSequence) => {
      // One watch per Thread: a newer one replaces the older, and its
      // connection with it, whichever window asked for it.
      const previous = watches.get(threadId);
      if (previous !== undefined) end(previous);

      const socket = connect().socket('/threads', {
        auth: { threadId, afterSequence },
      });
      socket.auth = { threadId, afterSequence };
      const watch: Watch = { target, threadId, socket, cursor: afterSequence };
      watches.set(threadId, watch);
      if (!destroyed.has(target)) {
        const listener = (): void => stopAll(target);
        destroyed.set(target, listener);
        target.once('destroyed', listener);
      }

      socket.on('thread:snapshot', (value: unknown) => {
        const snapshot = record(value);
        // Identity first: another Thread's snapshot is not this watch's to
        // report, let alone to advance this watch's cursor with.
        if (snapshot === undefined || snapshot.threadId !== threadId) return;
        if (!Array.isArray(snapshot.events)) {
          send(watch, {
            kind: 'error',
            threadId,
            message: 'The Thread event stream returned an invalid snapshot.',
          });
          return;
        }
        // Only this Thread's own events are replayed or counted, so an entry
        // naming another Thread cannot reach the window and cannot move the
        // cursor past events this Thread really holds.
        const events = (snapshot.events as readonly ThreadEvent[]).filter(
          (event) => event.threadId === threadId,
        );
        for (const event of events) {
          const sequence = eventSequence(event);
          if (sequence !== undefined)
            watch.cursor = Math.max(watch.cursor, sequence);
        }
        socket.auth = { threadId, afterSequence: watch.cursor };
        send(watch, {
          kind: 'snapshot',
          snapshot: { ...(value as ThreadSnapshot), events },
        });
      });
      socket.on('agent:event', (value: unknown) => {
        const entry = record(value);
        if (entry?.threadId !== threadId) return;
        const sequence = eventSequence(value);
        if (sequence === undefined) {
          send(watch, {
            kind: 'error',
            threadId,
            message: 'The Thread event stream returned an invalid event.',
          });
          return;
        }
        watch.cursor = Math.max(watch.cursor, sequence);
        socket.auth = { threadId, afterSequence: watch.cursor };
        send(watch, { kind: 'event', event: value as ThreadEvent });
      });
      socket.on('thread:updated', (value: unknown) => {
        if (record(value)?.id !== threadId) return;
        send(watch, { kind: 'updated', thread: value as Thread });
      });
      socket.on('thread:deleted', (value: unknown) => {
        const deleted = record(value);
        if (
          deleted?.threadId === threadId &&
          typeof deleted.projectId === 'string'
        ) {
          send(watch, {
            kind: 'deleted',
            projectId: deleted.projectId,
            threadId,
          });
        }
      });
      socket.on('workspace:error', (value: unknown) => {
        // The watch's own connection raised it, so it is this Thread's to show.
        send(watch, {
          kind: 'error',
          threadId,
          message: errorMessage(value),
        });
      });
      socket.connect();
    },
    stop,
    stopAll,
    close: () => {
      for (const watch of [...watches.values()]) release(watch);
      for (const target of [...destroyed.keys()]) forget(target);
      flushHistory();
    },
  };
};
