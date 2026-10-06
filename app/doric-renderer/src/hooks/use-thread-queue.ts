import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { toast } from 'sonner';

import { latestQueue, type ThreadQueue } from '@/domain/queue';
import { messageFrom } from '@/domain/workspace';
import { useConnectionStatus } from '@/hooks/use-connection-status';
import { queryKeys } from '@/queries/keys';
import { subscribeThreadQueue } from '@/stores/thread-chats';

export const useThreadQueue = (id: string | undefined) => {
  const client = useQueryClient();
  const connection = useConnectionStatus();
  const query = useQuery({
    queryKey: queryKeys.threadQueue(id),
    queryFn: () => window.doric.threads.queue(id!),
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
    mutationFn: () => window.doric.threads.resumeQueue(id!),
    onSuccess: () =>
      client.invalidateQueries({ queryKey: queryKeys.threadQueue(id) }),
    onError: (error) => toast.error(messageFrom(error)),
  });
  const remove = useMutation({
    mutationFn: (promptId: string) =>
      window.doric.threads.removeQueued(id!, promptId),
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
