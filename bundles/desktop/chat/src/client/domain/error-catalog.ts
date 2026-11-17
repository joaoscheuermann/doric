import type { ErrorCatalog } from 'desktop/reads';

/**
 * The chat's error catalog (§2.2): the entries of the codes the chat defines,
 * and the chat's own wording of the shared `auth_*` codes, which point the
 * reader to Settings — a place the shared entries may not name (D3).
 *
 * Passed as `catalog` to every `ErrorNotice` and `toastError` the chat draws;
 * they merge it over the shared entries, so an entry here wins for a code both
 * list. An entry without `explanation` shows the error's own message (§2.3);
 * an entry without `tone` is an error. Plain data: every title and
 * explanation is English and one line, and the record is never mutated.
 */
export const chatErrorCatalog: ErrorCatalog = {
  prompt_failed: { title: 'Prompt failed', retryable: true },
  tool_failed: { title: 'Tool failed', retryable: false },
  resume_exhausted: {
    title: 'Execution stopped',
    explanation:
      'The host restarted three times during this prompt, so the work may be incomplete; retry to send the prompt again.',
    retryable: true,
    tone: 'warning',
  },
  thread_execution_unavailable: {
    title: 'Model unavailable',
    retryable: false,
  },
  summarizer_failed: {
    title: 'Compaction failed',
    explanation: 'Earlier messages could not be summarized.',
    retryable: false,
  },
  unsafe_boundary: {
    title: 'Compaction skipped',
    explanation: 'No safe point was found to summarize earlier messages.',
    retryable: false,
  },
  queue_paused: { title: 'Execution paused', retryable: true },
  queue_refresh_failed: { title: 'Queue not refreshed', retryable: true },
  send_failed: { title: 'Prompt not sent', retryable: false },
  stop_failed: { title: 'Could not stop', retryable: false },
  queue_action_failed: { title: 'Queue not updated', retryable: false },
  queue_edit_failed: { title: 'Prompt not edited', retryable: false },
  command_failed: { title: 'Action failed', retryable: false },
  attach_failed: { title: 'Image not attached', retryable: false },
  auth_failed: {
    title: 'Sign-in rejected',
    explanation:
      '{provider} refused the credentials; check the provider in Settings.',
    retryable: false,
  },
  auth_missing: {
    title: 'Credentials missing',
    explanation: '{provider} needs a credential; add one in Settings.',
    retryable: false,
  },
  auth_ambiguous: {
    title: 'Credentials ambiguous',
    explanation:
      'More than one credential matches {provider}; keep one in Settings.',
    retryable: false,
  },
};
