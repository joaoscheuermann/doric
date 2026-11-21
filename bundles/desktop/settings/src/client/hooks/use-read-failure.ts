import type { UseQueryResult } from '@tanstack/react-query';
import type { ErrorInfo } from 'desktop/reads';
import { useMemo, useRef } from 'react';

import { failureInfo, keptFailure } from '../domain/read-failure.js';

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
  kept.current = keptFailure(kept.current, query);
  const failure = kept.current;
  const failedAt = query.errorUpdatedAt;
  return useMemo(() => failureInfo(failure, failedAt), [failure, failedAt]);
};
