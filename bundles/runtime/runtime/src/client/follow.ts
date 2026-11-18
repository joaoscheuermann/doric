// Follows one Project's live updates (bundle isolation phase 3), without
// React. What an update means for
// the records is a rule of `domain/tree.ts`; this only owns the subscription.

import type { ErrorInfo } from 'desktop/reads';

import type { ProjectWatch } from './api/project-watch.js';
import type { TreeUpdate } from './domain/tree.js';

export interface FollowOptions {
  /** The Project whose live Threads the caller follows. */
  readonly projectId: string;
  readonly onUpdate: (update: TreeUpdate) => void;
  /** The stream ended with a failure (`project_stream_failed` over its cause). */
  readonly onError: (error: ErrorInfo) => void;
}

/** Hands the Project's live updates to the caller; returns the stop. */
export const followProject = (
  watch: ProjectWatch,
  { projectId, onUpdate, onError }: FollowOptions,
): (() => void) =>
  watch.watch(projectId, (update) => {
    if (update.kind === 'error') onError(update.error);
    else onUpdate(update);
  });
