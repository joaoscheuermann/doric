import type { Query, QueryClient } from '@tanstack/react-query';

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

/** Revalidates the sandbox and every cached Git summary belonging to its Project. */
export function refreshProject(
  client: QueryClient,
  projectId: string,
  periodic = false,
): Promise<void> {
  let projects = queues.get(client);
  if (!projects) {
    projects = new Map();
    queues.set(client, projects);
  }
  let refresh = projects.get(projectId);
  if (!refresh) {
    const entry: Refresh = {
      includeErrors: false,
      queue: createRefreshQueue(async () => {
        const includeErrors = entry.includeErrors;
        entry.includeErrors = false;
        const filters = {
          predicate: (query: Query) => {
            // Failed reads own bounded retry and pending leases own their host
            // delay. Polling must not restart either policy every fifteen seconds.
            if (
              !includeErrors &&
              (query.state.status === 'error' ||
                (typeof query.state.data === 'object' &&
                  query.state.data !== null &&
                  'status' in query.state.data &&
                  query.state.data.status !== 'ready'))
            )
              return false;
            return (
              (query.queryKey[0] === 'files' &&
                query.queryKey[1] === projectId) ||
              (query.queryKey[0] === 'thread' &&
                query.meta?.projectId === projectId &&
                query.queryKey[2] === 'git')
            );
          },
        };
        // A request already in flight can predate the change. Let it settle, then
        // reread that subset, instead of cancelling IPC calls the host still runs.
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
    projects.set(projectId, entry);
    refresh = entry;
  }
  refresh.includeErrors ||= !periodic;
  return refresh.queue.request();
}
