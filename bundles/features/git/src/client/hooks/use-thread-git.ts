/**
 * One Thread's Git summary in the conversation footer. The project coordinator
 * refreshes it with the file reads; the cwd key isolates directory changes.
 */

import { useQuery } from '@tanstack/react-query';
import { messageFrom, pendingReadInterval, readRetry } from 'desktop/reads';
import { useCallback } from 'react';
import type { Thread } from 'runtime/contracts';

import { gitKeys } from '../changes/store.js';
import type { ThreadGit } from '../domain/thread-git.js';
import { gitClient, requestProjectRefresh } from '../state.js';

export type ThreadGitState = {
  /** The host's summary, absent until the first read lands. */
  readonly git?: ThreadGit;
  /** Why the summary could not be read; the footer still shows the path. */
  readonly error?: string;
  readonly refreshing: boolean;
  readonly refresh: () => void;
};

export const useThreadGit = (thread: Thread | undefined): ThreadGitState => {
  const id = thread?.id;
  const cwd = thread?.cwd;

  const query = useQuery({
    queryKey: gitKeys.threadGit(id, cwd),
    queryFn: () => (gitClient()?.store.api() ?? unbound()).git(id as string),
    enabled: id !== undefined,
    meta: { projectId: thread?.projectId },
    refetchInterval: (query) =>
      pendingReadInterval(
        query.state.data?.repo === false &&
          query.state.data.status !== undefined
          ? { status: query.state.data.status }
          : undefined,
      ),
    ...readRetry,
  });

  const projectId = thread?.projectId;
  const refresh = useCallback((): void => {
    if (projectId !== undefined) requestProjectRefresh(projectId);
  }, [projectId]);

  return {
    git: query.data,
    error: query.isError ? messageFrom(query.error) : undefined,
    refreshing: query.isFetching,
    refresh,
  };
};

/** No activation: the backend cannot be reached from this window. */
export const unbound = (): never => {
  throw new Error('Doric backend is unavailable.');
};
