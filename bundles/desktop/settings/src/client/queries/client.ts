import { QueryClient } from '@tanstack/react-query';

/**
 * The settings bundle's query client for one window. The host is local and
 * answers once, so nothing retries or refetches on its own: a read happens when
 * a surface asks for it and a reload happens when something invalidates it.
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

let shared: QueryClient | undefined;

/** One client per bundle per window, shared by its elements (design §10.6). */
export const settingsQueryClient = (): QueryClient => {
  shared ??= createQueryClient();
  return shared;
};

/** Drops the window's client when the bundle deactivates. */
export const clearSettingsQueryClient = (): void => {
  shared?.clear();
  shared = undefined;
};
