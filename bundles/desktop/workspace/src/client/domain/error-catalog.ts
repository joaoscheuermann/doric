import type { ErrorCatalog } from 'desktop/reads';

/**
 * The layout's error catalog (§2.2): the entries of the codes the layout
 * defines for the workspace sidebar and the dashboard.
 *
 * Passed as `catalog` to every `ErrorNotice` the layout draws except the
 * quarantine notice, which carries its own counted `bundle_quarantined` entry
 * (§7.2) and so has no entry here. `ErrorNotice` merges it over the shared
 * entries, so an entry here wins for a code both list. An entry without
 * `explanation` shows the error's own message (§2.3); an entry without `tone`
 * is an error. Plain data: every title and explanation is English and one
 * line, and the record is never mutated.
 */
export const layoutErrorCatalog: ErrorCatalog = {
  projects_load_failed: { title: 'Projects not loaded', retryable: true },
  threads_load_failed: { title: 'Threads not loaded', retryable: true },
  workspace_action_failed: { title: 'Change not saved', retryable: false },
  project_stream_failed: {
    title: 'Live updates stopped',
    explanation:
      'The sidebar stopped following this project; select it again to reconnect.',
    retryable: false,
  },
  clipboard_failed: { title: 'Could not copy', retryable: false },
};
