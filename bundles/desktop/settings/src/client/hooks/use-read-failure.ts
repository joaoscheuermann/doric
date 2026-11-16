import type { UseQueryResult } from '@tanstack/react-query';
import { type ErrorInfo, errorInfo } from 'desktop/reads';
import { useMemo, useRef } from 'react';

/**
 * The last failed read of `query` as `ErrorInfo` (`errorInfo` of its error,
 * `at` from its `errorUpdatedAt`), kept while a read that follows it runs, so
 * a notice stays on screen with its Retry busy; absent once a read succeeds.
 *
 * React Query clears the error of a query with no data when a read starts,
 * which would unmount the notice whose Retry started it.
 */
export const useReadFailure = (
  query: UseQueryResult<unknown>,
): ErrorInfo | undefined => {
  const kept = useRef<unknown>(undefined);
  if (query.isError) kept.current = query.error;
  else if (!(query.isPending && query.isFetching)) kept.current = undefined;
  const failure = kept.current;
  const failedAt = query.errorUpdatedAt;
  return useMemo(
    () =>
      failure === undefined
        ? undefined
        : errorInfo(failure, { at: new Date(failedAt).toISOString() }),
    [failure, failedAt],
  );
};
