// `thread-log.ts` — the `comments.*` events of one Thread's log, shared by every
// frame of that Thread in the window.
//
// A preview's threads (who answered, what was resolved, under which prompt)
// are read off the Thread's log, with the same reducer whatever frame shows
// them (`domain/preview-state.ts`). Every node of a conversation shows the
// same Thread, so they share one `runtime.threads/v1` `WatchThread` stream per
// Thread, over the generated client (slice S65b): the first frame to
// subscribe opens it, the last to leave closes it, and only the `comments.*`
// events are kept. A window without the watch never answers, and the frames
// keep reading `comments/v1.list`.
//
// `WatchThread` is resumable: the client opens a stream that ended with
// `generation_lost` again itself, with its first request, so a replay keeps
// only the events after the last sequence the log delivered. A stream lost
// with the bridge (`disconnected`, `unavailable`) subscribes again from that
// sequence when `doric.connection/v1` reports `connected`, or after
// `resubscribeDelayMs` when it already reads `connected`, and its replay
// extends the events held. Any other end leaves the log as it stands.

import type { JsonValue } from '@bufbuild/protobuf';
import { ConnectError } from '@connectrpc/connect';
import {
  type ClientServices,
  type Disposable,
  DoricConnectionV1,
  fromConnectError,
} from 'bundle/contracts';
import { decode, runtimeOneofs } from 'runtime/contracts';
import {
  ThreadsService,
  WatchThreadResponseSchema,
} from 'runtime/contracts/gen/doric/runtime/threads/v1/threads_pb.js';

import type { ThreadLogEvent, ThreadWatchItem } from '../../contracts/index.js';

const COMMENT_EVENT = /^comments\./;

/** The delay before subscribing again while the connection reads connected. */
export const resubscribeDelayMs = 1000;

type Listener = (events: readonly ThreadLogEvent[]) => void;

interface SharedLog {
  events: readonly ThreadLogEvent[];
  ready: boolean;
  readonly listeners: Set<Listener>;
  dispose?: () => void;
}

/**
 * Whether a stream ended because its way to the host was lost, not refused.
 * A lost host generation never ends the stream: the client opens it again.
 */
const lost = (error: unknown): boolean =>
  error instanceof ConnectError &&
  ['disconnected', 'unavailable'].includes(fromConnectError(error).code);

const isLogEvent = (value: unknown): value is ThreadLogEvent =>
  typeof value === 'object' &&
  value !== null &&
  typeof (value as { readonly type?: unknown }).type === 'string';

/**
 * One `WatchThread` item as today's JSON, read as the log reads it: a
 * snapshot's events and a live event; anything else is no item.
 */
const itemOf = (value: JsonValue): ThreadWatchItem | undefined => {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    return undefined;
  if (value.kind === 'snapshot' && Array.isArray(value.events))
    return {
      kind: 'snapshot',
      events: value.events.flatMap((event) =>
        isLogEvent(event) ? [event] : [],
      ),
    };
  if (value.kind === 'event' && isLogEvent(value.event))
    return { kind: 'event', event: value.event };

  return undefined;
};

/** The shared logs of each window's services, by Project and Thread. */
const logsOf = new WeakMap<ClientServices, Map<string, SharedLog>>();

const notify = (log: SharedLog): void => {
  for (const listener of [...log.listeners]) listener(log.events);
};

/**
 * Follows a Thread's log into the shared log, subscribing again from its
 * cursor whenever the stream is lost. Returns the release.
 */
const follow = (
  services: ClientServices,
  scope: { readonly projectId: string; readonly threadId: string },
  shared: SharedLog,
): (() => void) => {
  let cursor = 0;
  let active = true;
  let stream: AbortController | undefined;
  let waiting: Disposable | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const stopWaiting = (): void => {
    waiting?.dispose();
    waiting = undefined;
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
  };

  /** Whether `event` comes after what the log delivered; advances the cursor. */
  const fresh = (event: ThreadLogEvent): boolean => {
    if (event.sequence === undefined) return true;
    if (event.sequence <= cursor) return false;
    cursor = event.sequence;
    return true;
  };

  const receive = (item: ThreadWatchItem): void => {
    if (item.kind === 'snapshot') {
      // A replay may start before the cursor: what the log held is not kept twice.
      const replayed = item.events.filter(fresh);
      shared.events = [
        ...shared.events,
        ...replayed.filter((event) => COMMENT_EVENT.test(event.type)),
      ];
      shared.ready = true;
      notify(shared);

      return;
    }

    if (item.kind !== 'event') return;
    if (!fresh(item.event) || !COMMENT_EVENT.test(item.event.type)) return;

    shared.events = [...shared.events, item.event];
    if (shared.ready) notify(shared);
  };

  const subscribe = (): void => {
    stopWaiting();
    if (!active) return;
    const controller = new AbortController();
    const { signal } = controller;
    stream = controller;
    const live = (): boolean =>
      active && !signal.aborted && stream === controller;

    void (async () => {
      let failure: unknown;
      try {
        for await (const message of services
          .use(ThreadsService, scope)
          .watchThread(
            { threadId: scope.threadId, afterSequence: cursor },
            { signal },
          )) {
          if (!live()) return;
          const item = itemOf(
            decode(WatchThreadResponseSchema, message, runtimeOneofs),
          );
          if (item !== undefined) receive(item);
        }
      } catch (error) {
        // A composition without the Thread's watch: nothing to share.
        failure = error;
      }
      if (!live()) return;
      stream = undefined;
      if (lost(failure)) awaitConnection();
    })();
  };

  const awaitConnection = (): void => {
    stopWaiting();
    try {
      const connection = services.use(DoricConnectionV1);

      waiting = connection.subscribe((status) => {
        if (status === 'connected') subscribe();
      });
      if (connection.status() === 'connected')
        timer = setTimeout(subscribe, resubscribeDelayMs);
    } catch {
      // A window without the connection status cannot tell when to retry.
    }
  };

  subscribe();

  return () => {
    active = false;
    stopWaiting();
    stream?.abort();
    stream = undefined;
  };
};

/**
 * Subscribes to the `comments.*` events of a Thread's log: the listener hears
 * every event so far once the replay arrives, then the whole list again on
 * each new one. The release ends the subscription.
 */
export const watchThreadComments = (
  services: ClientServices,
  scope: { readonly projectId: string; readonly threadId: string },
  listener: Listener,
): (() => void) => {
  const key = `${scope.projectId}\u0000${scope.threadId}`;
  const logs = logsOf.get(services) ?? new Map<string, SharedLog>();
  logsOf.set(services, logs);
  let log = logs.get(key);

  if (log === undefined) {
    const shared: SharedLog = {
      events: [],
      ready: false,
      listeners: new Set(),
    };

    log = shared;
    logs.set(key, shared);
    shared.dispose = follow(services, scope, shared);
  }

  const shared = log;

  shared.listeners.add(listener);
  if (shared.ready) listener(shared.events);

  return () => {
    shared.listeners.delete(listener);

    if (shared.listeners.size === 0 && logs.get(key) === shared) {
      logs.delete(key);
      shared.dispose?.();
    }
  };
};
