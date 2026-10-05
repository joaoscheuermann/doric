/**
 * One Thread's Git summary in the conversation footer. The project coordinator
 * refreshes it with the file reads; the cwd key isolates directory changes.
 */

import { sandboxReadRetry } from '@/domain/sandbox-reads';
import type { ThreadGit } from '@/domain/thread-git';
import { messageFrom, type Thread } from '@/domain/workspace';
import { queryKeys } from '@/queries/keys';
import { refreshProject } from '@/queries/project-refresh';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback } from 'react';

export type ThreadGitState = {
  /** The host's summary, absent until the first read lands. */
  readonly git?: ThreadGit;
  /** Why the summary could not be read; the footer still shows the path. */
  readonly error?: string;
  readonly refreshing: boolean;
  readonly refresh: () => void;
};

export const useThreadGit = (thread: Thread | undefined): ThreadGitState => {
  const queryClient = useQueryClient();
  const id = thread?.id;
  const cwd = thread?.cwd;

  const query = useQuery({
    queryKey: queryKeys.threadGit(id, cwd),
    queryFn: () => window.doric.threads.git(id as string),
    enabled: id !== undefined,
    meta: { projectId: thread?.projectId },
    ...sandboxReadRetry,
  });

  const refresh = useCallback((): void => {
    if (thread !== undefined)
      void refreshProject(queryClient, thread.projectId);
  }, [queryClient, thread]);

  return {
    git: query.data,
    error: query.isError ? messageFrom(query.error) : undefined,
    refreshing: query.isFetching,
    refresh,
  };
};
