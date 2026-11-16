import type { ErrorInfo } from 'desktop/reads';
import { useEffect, useRef } from 'react';

import { projectWatch } from '../api/project-watch.js';
import type { TreeUpdate } from '../domain/project-tree.js';
import type { ProjectUpdate } from '../domain/workspace.js';

export type ProjectEventsOptions = {
  /** The Project whose live Threads the caller follows. */
  readonly projectId: string | undefined;
  readonly onUpdate: (update: TreeUpdate) => void;
  /** The stream ended with a failure (`project_stream_failed` over its cause). */
  readonly onError: (error: ErrorInfo) => void;
};

/**
 * Hands the selected Project's live updates to the caller. What an update means
 * for the cached tree is a rule and lives in `@/domain/project-tree`; this hook
 * only owns the subscription and its teardown.
 */
export const useProjectEvents = ({
  projectId,
  onUpdate,
  onError,
}: ProjectEventsOptions): void => {
  const latest = useRef({ onUpdate, onError });
  useEffect(() => {
    latest.current = { onUpdate, onError };
  });

  useEffect(() => {
    if (projectId === undefined) return;
    return projectWatch().watch(projectId, (update: ProjectUpdate) => {
      const current = latest.current;
      if (update.kind === 'error') current.onError(update.error);
      else current.onUpdate(update);
    });
  }, [projectId]);
};
