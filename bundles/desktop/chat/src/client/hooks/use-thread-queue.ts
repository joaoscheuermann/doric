import {
  type QueryClient,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import { toast } from 'desktop/ui/sonner';
import { useEffect } from 'react';

import { threadsApi } from '../api/threads-api.js';
import { messageFrom } from '../domain/errors.js';
import { latestQueue, type ThreadQueue } from '../domain/queue.js';
import { queryKeys } from '../queries/keys.js';
import { subscribeThreadQueue } from '../stores/thread-chats.js';
import { useConnectionStatus } from './use-connection-status.js';

/** How long queue invalidations wait so one read answers a burst of them. */
const REFRESH_SETTLE_MS = 100;

interface QueueRefresh {
  /** How many hooks observe this Thread's queue through this client. */
  count: number;
  timer: ReturnType<typeof setTimeout> | undefined;
  unsubscribe: () => void;
}

/**
 * One refresh per Thread per client, however many surfaces observe its queue:
 * the conversation, its queue block, the footer's controls and the chat hook
 * all read the same query, and a queue change is one read for all of them —
 * not one cancelled read per observer.
 */
const refreshes = new WeakMap<QueryClient, Map<string, QueueRefresh>>();

const refreshQueue = (client: QueryClient, id: string): void => {
  const refresh = refreshes.get(client)?.get(id);
  if (refresh === undefined) return;
  if (refresh.timer !== undefined) clearTimeout(refresh.timer);
  refresh.timer = setTimeout(() => {
    refresh.timer = undefined;
    void client
      .cancelQueries({ queryKey: queryKeys.threadQueue(id) })
      .then(() =>
        client.invalidateQueries({ queryKey: queryKeys.threadQueue(id) }),
      );
  }, REFRESH_SETTLE_MS);
};

/** Follows the Thread's queue changes while any hook observes it. */
const retainQueueRefresh = (client: QueryClient, id: string): (() => void) => {
  let byThread = refreshes.get(client);
  if (byThread === undefined) {
    byThread = new Map();
    refreshes.set(client, byThread);
  }
  let refresh = byThread.get(id);
  if (refresh === undefined) {
    refresh = {
      count: 0,
      timer: undefined,
      unsubscribe: subscribeThreadQueue(id, () => refreshQueue(client, id)),
    };
    byThread.set(id, refresh);
  }
  const held = refresh;
  held.count += 1;
  return () => {
    held.count -= 1;
    if (held.count > 0) return;
    held.unsubscribe();
    if (held.timer !== undefined) clearTimeout(held.timer);
    byThread.delete(id);
  };
};

export const useThreadQueue = (id: string | undefined) => {
  const client = useQueryClient();
  const connection = useConnectionStatus();
  const query = useQuery({
    queryKey: queryKeys.threadQueue(id),
    queryFn: () => threadsApi.queue(id as string),
    enabled: id !== undefined,
    refetchOnWindowFocus: true,
    retry: 2,
    structuralSharing: (previous, next) =>
      latestQueue(previous as ThreadQueue | undefined, next as ThreadQueue),
  });
  useEffect(() => {
    if (id === undefined) return;
    return retainQueueRefresh(client, id);
  }, [client, id]);
  useEffect(() => {
    if (id !== undefined && connection === 'connected')
      refreshQueue(client, id);
  }, [client, connection, id]);
  const resume = useMutation({
    mutationFn: () => threadsApi.resumeQueue(id as string),
    onSuccess: () =>
      client.invalidateQueries({ queryKey: queryKeys.threadQueue(id) }),
    onError: (error) => toast.error(messageFrom(error)),
  });
  const remove = useMutation({
    mutationFn: (promptId: string) =>
      threadsApi.removeQueued(id as string, promptId),
    onSuccess: () =>
      client.invalidateQueries({ queryKey: queryKeys.threadQueue(id) }),
    onError: (error) => toast.error(messageFrom(error)),
  });
  return {
    ...query,
    resume: () => resume.mutate(),
    resumeAsync: resume.mutateAsync,
    resuming: resume.isPending,
    remove: remove.mutate,
    removing: remove.isPending,
  };
};
