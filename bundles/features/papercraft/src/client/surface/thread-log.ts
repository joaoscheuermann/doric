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

import type { Services } from 'bundle/contracts';

import {
  RuntimeThreadsV1,
  type ThreadLogEvent,
} from '../../contracts/index.js';

const COMMENT_EVENT = /^comments\./;

type Listener = (events: readonly ThreadLogEvent[]) => void;

interface SharedLog {
  events: readonly ThreadLogEvent[];
  ready: boolean;
  readonly listeners: Set<Listener>;
  dispose?: () => void;
}

/** The shared logs of each window's services, by Project and Thread. */
const logsOf = new WeakMap<Services, Map<string, SharedLog>>();

const notify = (log: SharedLog): void => {
  for (const listener of [...log.listeners]) listener(log.events);
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

    try {
      const subscription = services
        .use(RuntimeThreadsV1, scope)
        .watchThread({ threadId: scope.threadId, afterSequence: 0 }, (item) => {
          if (item.kind === 'snapshot') {
            shared.events = item.events.filter((event) =>
              COMMENT_EVENT.test(event.type),
            );
            shared.ready = true;
            notify(shared);

            return;
          }

          if (item.kind !== 'event' || !COMMENT_EVENT.test(item.event.type))
            return;

          shared.events = [...shared.events, item.event];
          if (shared.ready) notify(shared);
        });

      shared.dispose = () => subscription.dispose();
    } catch {
      // A composition without the Thread's watch: nothing to share.
    }
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
