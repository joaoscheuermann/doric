// `thread-log.ts` — the `comments.*` and `artifacts.revised/v1` events of one
// Thread's log, shared by every frame of that Thread in the window.
//
// An artifact's threads (who answered, what was resolved, under which prompt)
// are read off the Thread's log, with the same reducer whatever frame shows
// them (`threads.ts`). Every node of a conversation shows the same Thread, so
// they share one `runtime.threads/v1.watchThread` per Project and Thread,
// whatever bundle subscribes — this module is one instance per window (the
// import map): the first subscriber opens it through its own source, the last
// to leave closes it, and only the `comments.*` and `artifacts.revised/v1`
// events are kept. A window without the watch never answers.
//
// A stream lost with the bridge (`disconnected`, `unavailable`) or with the
// host generation serving it (`generation_lost`) subscribes again from the
// last sequence it delivered — through the source of the most recent
// subscriber still subscribed — when `doric.connection/v1` reports
// `connected`, or after `resubscribeDelayMs` when it already reads
// `connected`, and its replay extends the events held. Any other end leaves
// the log as it stands.

import type {
  ContractError,
  Disposable,
  DoricConnection,
  StreamListener,
} from 'bundle/contracts';

/** One durable event of a Thread's log, as the watch delivers it. */
export interface ThreadLogEvent {
  readonly sequence?: number;
  /** The prompt the event was written under. */
  readonly promptId?: string;
  readonly type: string;
  readonly event: unknown;
  readonly createdAt?: string;
}

/** One item of `watchThread`: the replay first, then the live events. */
export type ThreadWatchItem =
  | { readonly kind: 'snapshot'; readonly events: readonly ThreadLogEvent[] }
  | { readonly kind: 'event'; readonly event: ThreadLogEvent }
  | { readonly kind: 'updated' | 'deleted' };

/**
 * The Thread watch a subscriber reads its log through: `runtime.threads/v1`'s
 * `watchThread`, already bound to the subscriber's call scope. A source that
 * throws is a window without the watch: its listeners never hear.
 */
export interface ThreadWatchSource {
  watchThread(
    input: { readonly threadId: string; readonly afterSequence: number },
    listener: StreamListener<ThreadWatchItem>,
  ): Disposable;
}

/** The Thread a log belongs to. */
export interface ThreadScope {
  readonly projectId: string;
  readonly threadId: string;
}

const COMMENT_EVENT = /^comments\./;
const REVISED_EVENT = 'artifacts.revised/v1';

/** The delay before subscribing again while the connection reads connected. */
export const resubscribeDelayMs = 1000;

type CommentListener = (events: readonly ThreadLogEvent[]) => void;

interface RevisionListener {
  readonly artifactId: string;
  readonly listener: (revision: number) => void;
}

/** One subscription to a shared log: the way it reads the log, and its listener. */
interface Subscriber {
  readonly source: ThreadWatchSource;
  readonly connection: DoricConnection | undefined;
  readonly comments?: CommentListener;
  readonly revisions?: RevisionListener;
}

interface SharedLog {
  comments: readonly ThreadLogEvent[];
  revised: readonly ThreadLogEvent[];
  ready: boolean;
  /** In the order they subscribed: the last one is the most recent. */
  readonly subscribers: Subscriber[];
  dispose?: () => void;
}

/** Whether a stream ended because its way to the host was lost, not refused. */
const lost = (error: ContractError | undefined): boolean =>
  error !== undefined &&
  ['disconnected', 'unavailable', 'generation_lost'].includes(error.code);

/** The shared logs of the window, by Project and Thread. */
const logs = new Map<string, SharedLog>();

const record = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : undefined;

/** The revision an `artifacts.revised/v1` event states of `artifactId`, if any. */
const revisionOf = (
  event: ThreadLogEvent,
  artifactId: string,
): number | undefined => {
  const payload = record(event.event);
  const revision = payload?.revision;

  return payload?.artifactId === artifactId &&
    typeof revision === 'number' &&
    Number.isInteger(revision) &&
    revision > 0
    ? revision
    : undefined;
};

const hearRevisions = (
  subscriber: Subscriber,
  events: readonly ThreadLogEvent[],
): void => {
  const revisions = subscriber.revisions;

  if (revisions === undefined) return;

  for (const event of events) {
    const revision = revisionOf(event, revisions.artifactId);

    if (revision !== undefined) revisions.listener(revision);
  }
};

const notifyComments = (log: SharedLog): void => {
  for (const subscriber of [...log.subscribers])
    subscriber.comments?.(log.comments);
};

const notifyRevisions = (
  log: SharedLog,
  events: readonly ThreadLogEvent[],
): void => {
  if (events.length === 0) return;

  for (const subscriber of [...log.subscribers])
    hearRevisions(subscriber, events);
};

/**
 * Follows a Thread's log into the shared log, subscribing again from its
 * cursor whenever the stream is lost. Returns the release.
 */
const follow = (scope: ThreadScope, shared: SharedLog): (() => void) => {
  let cursor = 0;
  let active = true;
  let stream: Disposable | undefined;
  let waiting: Disposable | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const latest = (): Subscriber | undefined => shared.subscribers.at(-1);

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
    const subscriber = latest();
    if (!active || subscriber === undefined) return;
    const from = cursor;
    let ended = false;
    const receive = (item: ThreadWatchItem): void => {
      if (!active || ended) return;
      if (item.kind === 'snapshot') {
        // The replay holds what came after the cursor it was asked from.
        const replayed = item.events.filter(
          (event) => event.sequence === undefined || event.sequence > from,
        );
        const revised = replayed.filter(
          (event) => event.type === REVISED_EVENT,
        );
        advance(item.events);
        shared.comments = [
          ...shared.comments,
          ...replayed.filter((event) => COMMENT_EVENT.test(event.type)),
        ];
        shared.revised = [...shared.revised, ...revised];
        shared.ready = true;
        notifyComments(shared);
        notifyRevisions(shared, revised);

        return;
      }

      if (item.kind !== 'event') return;
      const event = item.event;
      advance([event]);

      if (event.type === REVISED_EVENT) {
        shared.revised = [...shared.revised, event];
        if (shared.ready) notifyRevisions(shared, [event]);

        return;
      }

      if (!COMMENT_EVENT.test(event.type)) return;

      shared.comments = [...shared.comments, event];
      if (shared.ready) notifyComments(shared);
    };
    const end = (error?: ContractError): void => {
      if (!active || ended) return;
      ended = true;
      stream = undefined;
      if (lost(error)) awaitConnection();
    };

    try {
      const opened = subscriber.source.watchThread(
        { threadId: scope.threadId, afterSequence: from },
        { next: receive, end },
      );

      if (ended || !active) opened.dispose();
      else stream = opened;
    } catch {
      // A source without the Thread's watch: nothing to share.
    }
  };

  const awaitConnection = (): void => {
    stopWaiting();
    const connection = latest()?.connection;

    // Without the connection status there is no telling when to retry.
    if (connection === undefined) return;

    try {
      waiting = connection.subscribe((status) => {
        if (status === 'connected') subscribe();
      });
      if (connection.status() === 'connected')
        timer = setTimeout(subscribe, resubscribeDelayMs);
    } catch {
      // A connection that cannot be read cannot tell when to retry.
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

/** Joins (or opens) the shared log of `scope` with one subscriber. */
const join = (scope: ThreadScope, subscriber: Subscriber): (() => void) => {
  const key = `${scope.projectId}\u0000${scope.threadId}`;
  let log = logs.get(key);
  const opens = log === undefined;

  if (log === undefined) {
    log = { comments: [], revised: [], ready: false, subscribers: [] };
    logs.set(key, log);
  }

  const shared = log;

  shared.subscribers.push(subscriber);
  if (opens) shared.dispose = follow(scope, shared);
  else if (shared.ready) {
    subscriber.comments?.(shared.comments);
    hearRevisions(subscriber, shared.revised);
  }

  let released = false;

  return () => {
    if (released) return;
    released = true;

    const index = shared.subscribers.indexOf(subscriber);
    if (index >= 0) shared.subscribers.splice(index, 1);

    if (shared.subscribers.length === 0 && logs.get(key) === shared) {
      logs.delete(key);
      shared.dispose?.();
    }
  };
};

/**
 * Subscribes to the `comments.*` events of a Thread's log. The log is shared
 * by every subscriber of the same Project and Thread in the window, whatever
 * bundle subscribes: the first subscriber opens one `watchThread` through its
 * `source`, and the last release closes it. The listener hears every
 * `comments.*` event held so far once the replay is in (at once, when it
 * already is), then the whole list again on each new `comments.*` event —
 * never on another event type. A stream lost with the bridge or the host
 * generation (`disconnected`, `unavailable`, `generation_lost`) subscribes
 * again from the last sequence delivered — through the source of the most
 * recent subscriber still subscribed — when `connection` reports `connected`,
 * or after `resubscribeDelayMs` when it already reads so; any other end, or no
 * `connection`, leaves the log as it stands. Returns the release; releasing
 * twice is harmless.
 */
export const watchThreadComments = (
  source: ThreadWatchSource,
  connection: DoricConnection | undefined,
  scope: ThreadScope,
  listener: (events: readonly ThreadLogEvent[]) => void,
): (() => void) => join(scope, { source, connection, comments: listener });

/**
 * Subscribes to the revisions of one artifact in a Thread's log, through the
 * same shared log as `watchThreadComments` (same sharing, resubscribe and
 * release). Once the replay is in, the listener hears the revision of every
 * held `artifacts.revised/v1` whose `artifactId` is `artifactId`, in log order,
 * then the revision of each new one. Repeats are not filtered, and an event
 * without a positive integer revision is not heard. Returns the release.
 */
export const watchArtifactRevisions = (
  source: ThreadWatchSource,
  connection: DoricConnection | undefined,
  scope: ThreadScope,
  artifactId: string,
  listener: (revision: number) => void,
): (() => void) =>
  join(scope, { source, connection, revisions: { artifactId, listener } });
