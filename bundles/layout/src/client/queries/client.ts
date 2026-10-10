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

let current: QueryClient | undefined;

/**
 * The window's layout query client (stage 9 §5.3): shared by the workspace
 * view and the activation's sandbox-activity subscription, so a refresh from
 * chat's hook reaches the queries the frame renders.
 */
export const layoutQueryClient = (): QueryClient => {
  current ??= createQueryClient();
  return current;
};

/** Drops the window's query client on deactivation. */
export const resetLayoutQueryClient = (): void => {
  current?.clear();
  current = undefined;
};
