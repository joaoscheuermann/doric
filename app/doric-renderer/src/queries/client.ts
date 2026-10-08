import { QueryClient } from '@tanstack/react-query';

/**
 * The query client for one window. The host is local and answers once, so
 * nothing retries or refetches on its own: a read happens when a surface asks
 * for it and a reload happens when something invalidates it.
 */
export const createQueryClient = (): QueryClient =>
  new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
        refetchOnWindowFocus: false,
        refetchOnReconnect: false,
        staleTime: 0,
      },
      mutations: {
        retry: false,
      },
    },
  });
