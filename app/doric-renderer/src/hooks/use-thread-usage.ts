import { useQuery } from '@tanstack/react-query';

import type { Thread } from '@/domain/workspace';
import { queryKeys } from '@/queries/keys';

/** One host aggregate also covers descendants without opening their logs. */
export const useThreadUsage = (thread: Thread | undefined) =>
  useQuery({
    queryKey: queryKeys.threadUsage(thread?.id),
    queryFn: () => window.doric.threads.usage(thread?.id as string),
    enabled: thread !== undefined,
    refetchInterval: 3000,
    refetchOnWindowFocus: true,
    staleTime: 1000,
    retry: 2,
  });
