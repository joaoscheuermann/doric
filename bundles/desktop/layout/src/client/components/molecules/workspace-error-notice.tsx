import { ErrorNotice } from 'desktop/ui/error-notice';

import { layoutErrorCatalog } from '../../domain/error-catalog.js';
import type { WorkspaceError, WorkspaceRetry } from '../../domain/sidebar.js';

/** The entry a workspace error falls back to, by its retry target (§8). */
const fallbackFor = (retry: WorkspaceRetry | undefined): string => {
  if (retry === undefined) return 'workspace_action_failed';
  return retry.kind === 'projects'
    ? 'projects_load_failed'
    : 'threads_load_failed';
};

/**
 * The one workspace error (§8), drawn the same way by the project sidebar
 * and by both dashboard bodies.
 *
 * Renders an announced `ErrorNotice` in the default `block` variant for
 * `error.error`, titled through `layoutErrorCatalog`. Its fallback code
 * follows the retry target: `projects_load_failed` for `{ kind: 'projects' }`,
 * `threads_load_failed` for `{ kind: 'threads' }`, `workspace_action_failed`
 * when there is none. It offers Retry, calling `onRetry`, only when
 * `error.retry` is set (and the entry allows it, §2.3); an error with no
 * retry target shows no Retry. `className` is passed to the notice's root. A
 * remount with the same error (a frame switch) is not announced again
 * (§3.6).
 */
export function WorkspaceErrorNotice({
  error,
  onRetry,
  className,
}: {
  readonly error: WorkspaceError;
  readonly onRetry: () => void;
  readonly className?: string;
}) {
  return (
    <ErrorNotice
      announce
      error={error.error}
      catalog={layoutErrorCatalog}
      fallbackCode={fallbackFor(error.retry)}
      onRetry={error.retry === undefined ? undefined : onRetry}
      className={className}
    />
  );
}
