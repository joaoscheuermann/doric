import type { ErrorCatalog } from 'desktop/reads';

/**
 * The settings bundle's error catalog (§2.2): the entries of the codes the
 * settings surfaces name as each surface's `fallbackCode`.
 *
 * Passed as `catalog` to every `ErrorNotice` and `toastError` the settings
 * bundle draws; they merge it over the shared entries, so an entry here wins
 * for a code both list. No entry has an `explanation`, so every notice shows
 * the error's own message (§2.3); no entry has a `tone`, so every one is an
 * error. `retryable` says only whether Retry may show: a notice still needs
 * the surface's `onRetry`, and a headline level saying `retryable: false`
 * still vetoes it (D5). Plain data: every title is English and one line, and
 * the record is never mutated.
 */
export const settingsErrorCatalog: ErrorCatalog = {
  config_save_failed: { title: 'Settings not saved', retryable: true },
  catalog_read_failed: { title: 'Models not read', retryable: true },
  tools_read_failed: { title: 'Tools not loaded', retryable: true },
  kinds_read_failed: { title: 'Providers not loaded', retryable: true },
  credentials_read_failed: { title: 'Credentials not loaded', retryable: true },
  credential_write_failed: { title: 'Credential not saved', retryable: false },
  sign_in_failed: { title: 'Sign-in failed', retryable: false },
  browser_failed: { title: 'Page not opened', retryable: false },
};
