// `thread-log.ts` — the `comments.*` events of one Thread's log, shared by every
// frame of that Thread in the window.
//
// A preview's threads (who answered, what was resolved, under which prompt)
// are read off the Thread's log, with the same reducer whatever frame shows
// them (`domain/preview-state.ts`). Every node of a conversation shows the
// same Thread, so they share one `runtime.threads/v1.watchThread` per Thread:
// the first frame to subscribe opens it, the last to leave closes it, and only
// the `comments.*` events are kept. A window without the watch never answers,
// and the frames keep reading `comments/v1.list`.
//
// A stream lost with the bridge (`disconnected`, `unavailable`) or with the
// host generation serving it (`generation_lost`) subscribes again from the
// last sequence it delivered when `doric.connection/v1` reports `connected`,
// or after `resubscribeDelayMs` when it already reads `connected`, and its
// replay extends the events held. Any other end leaves the log as it stands.

import {
  type ContractError,
  type Disposable,
  DoricConnectionV1,
  type Services,
} from 'bundle/contracts';

import {
  RuntimeThreadsV1,
  type ThreadLogEvent,
  type ThreadWatchItem,
} from '../../contracts/index.js';

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

/** Whether a stream ended because its way to the host was lost, not refused. */
const lost = (error: ContractError | undefined): boolean =>
  error !== undefined &&
  ['disconnected', 'unavailable', 'generation_lost'].includes(error.code);

/** The shared logs of each window's services, by Project and Thread. */
const logsOf = new WeakMap<Services, Map<string, SharedLog>>();

const notify = (log: SharedLog): void => {
  for (const listener of [...log.listeners]) listener(log.events);
};

/**
 * Follows a Thread's log into the shared log, subscribing again from its
 * cursor whenever the stream is lost. Returns the release.
 */
const follow = (
  services: Services,
  scope: { readonly projectId: string; readonly threadId: string },
  shared: SharedLog,
): (() => void) => {
  let cursor = 0;
  let active = true;
  let stream: Disposable | undefined;
  let waiting: Disposable | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const stopWaiting = (): void => {
    waiting?.dispose();
    waiting = undefined;
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
  };

  const advance = (events: readonly ThreadLogEvent[]): void => {
    for (const event of events)
      if (event.sequence !== undefined)
        cursor = Math.max(cursor, event.sequence);
  };

  const subscribe = (): void => {
    stopWaiting();
    if (!active) return;
    const from = cursor;
    let ended = false;
    const receive = (item: ThreadWatchItem): void => {
      if (!active || ended) return;
      if (item.kind === 'snapshot') {
        // The replay holds what came after the cursor it was asked from.
        const replayed = item.events.filter(
          (event) => event.sequence === undefined || event.sequence > from,
        );
        advance(item.events);
        shared.events = [
          ...shared.events,
          ...replayed.filter((event) => COMMENT_EVENT.test(event.type)),
        ];
        shared.ready = true;
        notify(shared);

        return;
      }

      if (item.kind !== 'event') return;
      advance([item.event]);
      if (!COMMENT_EVENT.test(item.event.type)) return;

      shared.events = [...shared.events, item.event];
      if (shared.ready) notify(shared);
    };
    const end = (error?: ContractError): void => {
      if (!active || ended) return;
      ended = true;
      stream = undefined;
      if (lost(error)) awaitConnection();
    };

    try {
      const opened = services
        .use(RuntimeThreadsV1, scope)
        .watchThread(
          { threadId: scope.threadId, afterSequence: from },
          { next: receive, end },
        );

      if (ended || !active) opened.dispose();
      else stream = opened;
    } catch {
      // A composition without the Thread's watch: nothing to share.
    }
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
    stream?.dispose();
    stream = undefined;
  };
};

/**
 * Subscribes to the `comments.*` events of a Thread's log: the listener hears
 * every event so far once the replay arrives, then the whole list again on
 * each new one. The release ends the subscription.
 */
export const watchThreadComments = (
  services: Services,
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
