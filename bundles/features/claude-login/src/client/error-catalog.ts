import type { ErrorCatalog } from 'desktop/reads';

/**
 * The claude-login bundle's error catalog (§2.2): the entry of the code its
 * sign-in toast names as its `fallbackCode`. Passed as `catalog` to that
 * `toastError`, which merges it over the shared entries. The entry has no
 * `explanation`, so the toast shows the error's own message (§2.3).
 */
export const claudeLoginErrorCatalog: ErrorCatalog = {
  sign_in_failed: { title: 'Sign-in failed', retryable: false },
};
