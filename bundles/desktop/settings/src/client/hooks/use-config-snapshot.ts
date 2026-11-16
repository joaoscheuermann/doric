import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';

import { api } from '../api/settings-api.js';
import type { Configuration } from '../domain/config.js';
import { messageFrom } from '../domain/errors.js';
import { queryKeys } from '../queries/keys.js';

/**
 * The stored configuration (`api().config.get()`), refetched on window focus
 * and after `useConfig` saves. No draft, no writes. `configuration` is
 * absent until the first read lands; `error` is the last read's message.
 */
export const useConfigSnapshot = (): {
  readonly configuration?: Configuration;
  readonly error?: string;
} => {
  const queryClient = useQueryClient();
  const snapshot = useQuery({
    queryKey: queryKeys.configSnapshot,
    queryFn: () => api().config.get(),
  });

  // The workspace and settings windows share the configuration, so a change
  // saved in the other window is read again when this one regains focus.
  useEffect(() => {
    const onFocus = (): void => {
      void queryClient.refetchQueries({
        queryKey: queryKeys.configSnapshot,
        exact: true,
      });
    };
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [queryClient]);

  return {
    configuration: snapshot.data?.configuration,
    error: snapshot.isError ? messageFrom(snapshot.error) : undefined,
  };
};
