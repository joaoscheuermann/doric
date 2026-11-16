import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { ErrorInfo } from 'desktop/reads';
import { useEffect } from 'react';

import { api } from '../api/settings-api.js';
import type { Configuration } from '../domain/config.js';
import { queryKeys } from '../queries/keys.js';
import { useReadFailure } from './use-read-failure.js';

/**
 * The stored configuration (`api().config.get()`), refetched on window focus
 * and after `useConfig` saves. No draft, no writes.
 *
 * - `configuration` is absent until the first read lands, and keeps the last
 *   read's value while a later read fails or runs.
 * - `error` is the last read's failure as `ErrorInfo` (`errorInfo` of the
 *   query's error, with `at` from its `errorUpdatedAt`); absent once a read
 *   succeeds. The hook never throws for a failed read.
 * - `reload` reads again (the query's own refetch); it returns at once, never
 *   throws, and a repeat while a read runs starts no second one.
 * - `reloading` is true while any read of this query runs, the first one
 *   included, so a notice whose error stays on screen can show progress.
 */
export const useConfigSnapshot = (): {
  readonly configuration?: Configuration;
  readonly error?: ErrorInfo;
  readonly reload: () => void;
  readonly reloading: boolean;
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

  const error = useReadFailure(snapshot);

  return {
    configuration: snapshot.data?.configuration,
    error,
    reload: () => {
      void snapshot.refetch();
    },
    reloading: snapshot.isFetching,
  };
};
