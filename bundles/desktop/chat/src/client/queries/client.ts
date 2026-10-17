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

/**
 * The chat's one query client in this window, shared by every chat root
 * (the conversation and the footer composer), so a queue invalidation in one
 * reaches the other as it did with the window's single client.
 */
export const chatQueryClient: QueryClient = createQueryClient();
