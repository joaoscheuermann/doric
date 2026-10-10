import { useQuery } from '@tanstack/react-query';

import type { Thread } from '../../../domain/workspace.js';
import { queryKeys } from '../../../queries/keys.js';
import { api } from '../../api/provisional-api.js';

/** One host aggregate also covers descendants without opening their logs. */
export const useThreadUsage = (thread: Thread | undefined) =>
  useQuery({
    queryKey: queryKeys.threadUsage(thread?.id),
    queryFn: () => api.threads.usage(thread?.id as string),
    enabled: thread !== undefined,
    refetchInterval: 3000,
    refetchOnWindowFocus: true,
    staleTime: 1000,
    retry: 2,
  });
