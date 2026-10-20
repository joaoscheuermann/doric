// One Thread watch per Thread over `runtime.threads/v1.watchThread` (§7.5),
// the port of `app/desktop/doric/src/workspace/events.ts`: a newer watch replaces the
// older; updates naming another Thread are dropped and foreign events inside
// a snapshot are filtered; an invalid snapshot or event becomes an `error`
// update with the fixed message; the cursor is the highest delivered
// sequence. A host failure shows its message when it has a code and a
// message, else the generic sentence. Losing the bridge (`disconnected`, or
// `unavailable`) reports nothing and resubscribes from the cursor when
// `doric.connection/v1` reports `connected` again, as the socket reconnected.
// The connection status follows a socket of its own, so it can read
// `connected` while the bridge is still down: then the watch resubscribes
// after `resubscribeDelayMs` instead, and again for as long as each
// resubscription ends the same way.

import {
  type CallArg,
  type ConnectionStatus,
  type Disposable,
  DoricConnectionV1,
  type StreamObserver,
} from 'bundle/contracts';
import { RuntimeThreadsV1 } from 'runtime/contracts';

import type { Thread, ThreadEvent, ThreadUpdate } from '../domain/workspace.js';
import { chatServices } from '../services/chat-services.js';

/**
 * One item of `watchThread` (`runtime/contracts` `ThreadWatchItem`), named
 * after the `/threads` namespace events, read as loosely as the socket
 * payloads were. A failed replay ends the stream with its error instead of
 * a `workspace:error` item.
 */
export type ThreadStreamItem =
  | {
      readonly kind: 'snapshot';
      readonly threadId: unknown;
      readonly projectId?: unknown;
      readonly project?: unknown;
      readonly thread?: unknown;
      readonly events: unknown;
    }
  | { readonly kind: 'event'; readonly event: unknown }
  | { readonly kind: 'updated'; readonly thread: unknown }
  | {
      readonly kind: 'deleted';
      readonly projectId: unknown;
      readonly threadId: unknown;
    };

/** The stream member the chat binds: `runtime.threads/v1.watchThread`. */
export interface ThreadStream {
  watchThread(
    input: { readonly threadId: string; readonly afterSequence: number },
    listener: StreamObserver<ThreadStreamItem>,
    call?: CallArg,
  ): Disposable;
}

/** The connection status source (`doric.connection/v1`). */
export interface ConnectionSource {
  status(): ConnectionStatus;
  subscribe(listener: (status: ConnectionStatus) => void): Disposable;
}

export interface ThreadWatchSources {
  readonly stream: () => ThreadStream;
  readonly connection: () => ConnectionSource | undefined;
  /** Runs `run` after `ms`, answering its cancel; `setTimeout` by default. */
  readonly schedule?: (run: () => void, ms: number) => () => void;
}

export interface ThreadWatch {
  /**
   * Watches one Thread from `afterSequence`, replacing any watch already held
   * for it, and returns its idempotent release.
   */
  watch(
    threadId: string,
    afterSequence: number,
    listener: (update: ThreadUpdate) => void,
  ): () => void;
}

export const invalidSnapshotMessage =
  'The Thread event stream returned an invalid snapshot.';
export const invalidEventMessage =
  'The Thread event stream returned an invalid event.';
export const streamFailedMessage = 'The Thread event stream failed.';

/** The delay before subscribing again while the connection reads connected. */
export const resubscribeDelayMs = 1000;

const timeout = (run: () => void, ms: number): (() => void) => {
  const timer = setTimeout(run, ms);
  return () => clearTimeout(timer);
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
    : streamFailedMessage;
};

interface Watch {
  readonly threadId: string;
  readonly listener: (update: ThreadUpdate) => void;
  cursor: number;
  subscription: Disposable | undefined;
  reconnect: Disposable | undefined;
  /** Cancels the delayed resubscription, while one is scheduled. */
  retry: (() => void) | undefined;
  released: boolean;
}

export const createThreadWatch = (sources: ThreadWatchSources): ThreadWatch => {
  const watches = new Map<string, Watch>();
  const schedule = sources.schedule ?? timeout;

  /** Stops waiting for the connection: its listener and its delayed retry. */
  const stopWaiting = (watch: Watch): void => {
    watch.reconnect?.dispose();
    watch.reconnect = undefined;
    watch.retry?.();
    watch.retry = undefined;
  };

  const send = (watch: Watch, update: ThreadUpdate): void => {
    if (watch.released || watches.get(watch.threadId) !== watch) return;
    watch.listener(update);
  };

  const release = (watch: Watch): void => {
    if (watch.released) return;
    watch.released = true;
    if (watches.get(watch.threadId) === watch) watches.delete(watch.threadId);
    stopWaiting(watch);
    const subscription = watch.subscription;
    watch.subscription = undefined;
    try {
      subscription?.dispose();
    } catch {
      // A stream that cannot be released is already gone.
    }
  };

  const receive = (watch: Watch, item: ThreadStreamItem): void => {
    const { threadId } = watch;
    switch (item.kind) {
      case 'snapshot': {
        // Identity first: another Thread's snapshot is not this watch's to
        // report, let alone to advance this watch's cursor with.
        if (item.threadId !== threadId) return;
        if (!Array.isArray(item.events)) {
          send(watch, {
            kind: 'error',
            threadId,
            message: invalidSnapshotMessage,
          });
          return;
        }
        const events = (item.events as readonly ThreadEvent[]).filter(
          (event) => record(event)?.threadId === threadId,
        );
        for (const event of events) {
          const sequence = eventSequence(event);
          if (sequence !== undefined)
            watch.cursor = Math.max(watch.cursor, sequence);
        }
        const { kind: _kind, ...snapshot } = item;
        send(watch, {
          kind: 'snapshot',
          snapshot: {
            ...(snapshot as unknown as Extract<
              ThreadUpdate,
              { kind: 'snapshot' }
            >['snapshot']),
            events,
          },
        });
        return;
      }
      case 'event': {
        if (record(item.event)?.threadId !== threadId) return;
        const sequence = eventSequence(item.event);
        if (sequence === undefined) {
          send(watch, {
            kind: 'error',
            threadId,
            message: invalidEventMessage,
          });
          return;
        }
        watch.cursor = Math.max(watch.cursor, sequence);
        send(watch, { kind: 'event', event: item.event as ThreadEvent });
        return;
      }
      case 'updated':
        if (record(item.thread)?.id !== threadId) return;
        send(watch, { kind: 'updated', thread: item.thread as Thread });
        return;
      case 'deleted':
        if (item.threadId === threadId && typeof item.projectId === 'string') {
          send(watch, {
            kind: 'deleted',
            projectId: item.projectId,
            threadId,
          });
        }
        return;
    }
  };

  /**
   * Resubscribes from the cursor on the next `connected` report, or after a
   * delay when the connection already reads `connected`: its status follows a
   * socket of its own, which can be back before the bridge is.
   */
  const awaitConnection = (watch: Watch): void => {
    const connection = sources.connection();
    if (connection === undefined) return;
    stopWaiting(watch);
    const resume = (): void => {
      if (watch.released) return;
      stopWaiting(watch);
      subscribe(watch);
    };
    watch.reconnect = connection.subscribe((status) => {
      if (status === 'connected') resume();
    });
    if (connection.status() === 'connected')
      watch.retry = schedule(resume, resubscribeDelayMs);
  };

  /** A stream that ended: quietly on a lost bridge, else as an error. */
  const finish = (watch: Watch, error: unknown): void => {
    if (watch.released) return;
    watch.subscription = undefined;
    if (error === undefined) return;
    const code = record(error)?.code;
    if (code === 'disconnected' || code === 'unavailable') {
      awaitConnection(watch);
      return;
    }
    send(watch, {
      kind: 'error',
      threadId: watch.threadId,
      message: errorMessage(error),
    });
  };

  const subscribe = (watch: Watch): void => {
    let ended = false;
    const end = (error?: unknown): void => {
      if (ended) return;
      ended = true;
      finish(watch, error);
    };
    const observer: StreamObserver<ThreadStreamItem> = {
      next: (item) => {
        if (!ended && !watch.released) receive(watch, item);
      },
      end,
    };

    try {
      const subscription = sources
        .stream()
        .watchThread(
          { threadId: watch.threadId, afterSequence: watch.cursor },
          observer,
        );
      if (
        typeof (subscription as Partial<Disposable>)?.dispose !== 'function'
      ) {
        // Not a stream method: a provider without `watchThread`.
        end(new Error(streamFailedMessage));
        return;
      }
      if (ended || watch.released) subscription.dispose();
      else watch.subscription = subscription;
    } catch (error) {
      end(error ?? new Error(streamFailedMessage));
    }
  };

  return {
    watch: (threadId, afterSequence, listener) => {
      // One watch per Thread: a newer one replaces the older.
      const previous = watches.get(threadId);
      if (previous !== undefined) release(previous);

      const watch: Watch = {
        threadId,
        listener,
        cursor: afterSequence,
        subscription: undefined,
        reconnect: undefined,
        retry: undefined,
        released: false,
      };
      watches.set(threadId, watch);
      subscribe(watch);

      return () => release(watch);
    },
  };
};

/** The watch over the chat's activation services. */
export const threadWatch: ThreadWatch = createThreadWatch({
  stream: () => chatServices().use(RuntimeThreadsV1) as unknown as ThreadStream,
  connection: () => chatServices().use(DoricConnectionV1),
});
