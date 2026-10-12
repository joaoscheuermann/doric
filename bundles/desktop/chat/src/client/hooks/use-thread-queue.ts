import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'desktop-ui/sonner';
import { useEffect } from 'react';

import { threadsApi } from '../api/threads-api.js';
import { messageFrom } from '../domain/errors.js';
import { latestQueue, type ThreadQueue } from '../domain/queue.js';
import { queryKeys } from '../queries/keys.js';
import { subscribeThreadQueue } from '../stores/thread-chats.js';
import { useConnectionStatus } from './use-connection-status.js';

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
    let timer: ReturnType<typeof setTimeout> | undefined;
    const refresh = () => {
      if (timer !== undefined) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = undefined;
        void client
          .cancelQueries({ queryKey: queryKeys.threadQueue(id) })
          .then(() =>
            client.invalidateQueries({ queryKey: queryKeys.threadQueue(id) }),
          );
      }, 100);
    };
    const unsubscribe = subscribeThreadQueue(id, refresh);
    if (connection === 'connected') refresh();
    return () => {
      unsubscribe();
      if (timer !== undefined) clearTimeout(timer);
    };
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
