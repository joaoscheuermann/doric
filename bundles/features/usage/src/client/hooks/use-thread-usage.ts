import { useQuery } from '@tanstack/react-query';

import type { Usage } from '../../contracts/index.js';
import { readThreadUsage, usageQueryKey } from '../domain/read.js';

/** One host aggregate also covers descendants without opening their logs. */
export const useThreadUsage = (
  threadId: string | undefined,
  usage: Usage | undefined,
) =>
  useQuery({
    queryKey: usageQueryKey(threadId),
    queryFn: () => readThreadUsage(usage as Usage, threadId as string),
    enabled: threadId !== undefined && usage !== undefined,
    refetchInterval: 3000,
    refetchOnWindowFocus: true,
    staleTime: 1000,
    retry: 2,
  });
