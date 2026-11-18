/**
 * The failure a read surface keeps on screen, as pure rules: the React hook
 * (`use-read-failure.ts`) and the `settings.models/v1` service observe a query
 * and call these after every observation.
 */

import { type ErrorInfo, errorInfo } from 'desktop/reads';

/**
 * The kept failure after one observation of a query: its error while it is
 * failed, kept while a read that follows it runs, dropped once a read
 * succeeds. React Query clears the error of a query with no data when a read
 * starts, which would unmount the notice whose Retry started it.
 */
export const keptFailure = (
  kept: unknown,
  state: {
    readonly isError: boolean;
    readonly error: unknown;
    readonly isPending: boolean;
    readonly isFetching: boolean;
  },
): unknown => {
  if (state.isError) return state.error;
  return state.isPending && state.isFetching ? kept : undefined;
};

/** The kept failure as `ErrorInfo`, `at` from when it failed; `undefined` for none. */
export const failureInfo = (
  failure: unknown,
  failedAt: number,
): ErrorInfo | undefined =>
  failure === undefined
    ? undefined
    : errorInfo(failure, { at: new Date(failedAt).toISOString() });
