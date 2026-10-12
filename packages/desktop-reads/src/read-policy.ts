/** Recovery is bounded; another user or host signal can try again. */
export const readRetry = {
  retry: 3,
  retryDelay: (attempt: number): number => Math.min(1000 * 2 ** attempt, 8000),
};

/**
 * A read the host answers as pending follows the host's own hint; every other
 * answer is final for the read and does not poll.
 */
export const pendingReadInterval = (
  result:
    | { readonly status: string; readonly retryAfterSeconds?: number }
    | undefined,
): number | false => {
  if (result?.status !== 'pending') return false;
  const seconds = result.retryAfterSeconds;
  return seconds !== undefined && Number.isFinite(seconds) && seconds > 0
    ? Math.max(1000, seconds * 1000)
    : 3000;
};
