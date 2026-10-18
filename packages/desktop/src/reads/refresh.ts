import type { Query, QueryClient } from '@tanstack/query-core';

/** Groups bursts and retains one trailing refresh when changes arrive during a read. */
export function createRefreshQueue(read: () => Promise<void>, delayMs = 250) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pending = false;
  let running = false;
  let disposed = false;
  let waiters: (() => void)[] = [];

  const schedule = () => {
    if (disposed || running || timer !== undefined) return;
    timer = setTimeout(() => void flush(), delayMs);
  };
  const flush = async () => {
    timer = undefined;
    if (disposed) return;
    pending = false;
    running = true;
    try {
      await read();
    } finally {
      running = false;
      if (pending && !disposed) schedule();
      else {
        const finished = waiters;
        waiters = [];
        finished.forEach((resolve) => void resolve());
      }
    }
  };
  return {
    request: (): Promise<void> => {
      if (disposed) return Promise.resolve();
      pending = true;
      const result = new Promise<void>((resolve) => waiters.push(resolve));
      schedule();
      return result;
    },
    dispose: () => {
      disposed = true;
      if (timer !== undefined) clearTimeout(timer);
      waiters.forEach((resolve) => void resolve());
      waiters = [];
    },
  };
}

type Refresh = {
  includeErrors: boolean;
  queue: ReturnType<typeof createRefreshQueue>;
};
const queues = new WeakMap<QueryClient, Map<string, Refresh>>();

/**
 * Rereads the queries of one scope in a client: those `matches` selects and
 * that are observed. A failed read and a read whose data is not ready (a lease
 * still pending) own their retry schedule, so a periodic refresh leaves them
 * alone; a refresh that is not periodic includes them. Reads in flight when the
 * refresh starts settle first, then the subset is reread, so an IPC call the
 * host still runs is never cancelled.
 *
 * `scope` names the queue: one trailing refresh per client and scope.
 */
export function refreshQueries(
  client: QueryClient,
  scope: string,
  matches: (query: Query) => boolean,
  periodic = false,
): Promise<void> {
  let scopes = queues.get(client);
  if (!scopes) {
    scopes = new Map();
    queues.set(client, scopes);
  }
  let refresh = scopes.get(scope);
  if (!refresh) {
    const entry: Refresh = {
      includeErrors: false,
      queue: createRefreshQueue(async () => {
        const includeErrors = entry.includeErrors;
        entry.includeErrors = false;
        const filters = {
          predicate: (query: Query) => {
            if (
              !includeErrors &&
              (query.state.status === 'error' ||
                (typeof query.state.data === 'object' &&
                  query.state.data !== null &&
                  'status' in query.state.data &&
                  query.state.data.status !== 'ready'))
            )
              return false;
            return matches(query);
          },
        };
        const inFlight = new Set(
          client
            .getQueryCache()
            .findAll(filters)
            .filter((query) => query.state.fetchStatus === 'fetching'),
        );
        await client.invalidateQueries({ ...filters, refetchType: 'none' });
        await client.refetchQueries(
          { ...filters, type: 'active' },
          { cancelRefetch: false },
        );
        if (inFlight.size > 0) {
          await client.refetchQueries(
            {
              type: 'active',
              predicate: (query) =>
                inFlight.has(query) &&
                query.state.status === 'success' &&
                !(
                  typeof query.state.data === 'object' &&
                  query.state.data !== null &&
                  'status' in query.state.data &&
                  query.state.data.status !== 'ready'
                ),
            },
            { cancelRefetch: false },
          );
        }
      }),
    };
    scopes.set(scope, entry);
    refresh = entry;
  }
  refresh.includeErrors ||= !periodic;
  return refresh.queue.request();
}
