/**
 * One Thread's Git summary in the right panel footer. The project coordinator
 * refreshes it with the file reads; the cwd key isolates directory changes.
 */

import { sandboxReadRetry } from '@/domain/sandbox-reads';
import type { ThreadGit } from '@/domain/thread-git';
import { messageFrom, type Thread } from '@/domain/workspace';
import { queryKeys } from '@/queries/keys';
import { refreshProject } from '@/queries/project-refresh';
import { workspaceStore } from '@/stores/workspace';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useRef, useState } from 'react';

export type ThreadGitState = {
  /** The host's summary, absent until the first read lands. */
  readonly git?: ThreadGit;
  /** Why the summary could not be read; the footer still shows the path. */
  readonly error?: string;
  readonly refreshing: boolean;
  readonly refresh: () => void;
  /** The host's refusal of the last `setCwd`, shown beside the field. */
  readonly cwdError?: string;
  /** Moves the Thread's working directory; a refusal is reported, not thrown. */
  readonly setCwd: (cwd: string) => Promise<void>;
};

export const useThreadGit = (thread: Thread | undefined): ThreadGitState => {
  const queryClient = useQueryClient();
  const [cwdFailure, setCwdFailure] = useState<{
    threadId: string;
    cwd: string;
    message: string;
  }>();
  const id = thread?.id;
  const cwd = thread?.cwd;
  const currentThread = useRef(thread);
  currentThread.current = thread;

  const query = useQuery({
    queryKey: queryKeys.threadGit(id, cwd),
    queryFn: () => window.doric.threads.git(id as string),
    enabled: id !== undefined,
    meta: { projectId: thread?.projectId },
    ...sandboxReadRetry,
  });

  const setCwd = useCallback(
    async (next: string): Promise<void> => {
      if (thread === undefined) return;
      try {
        const updated = await window.doric.threads.setCwd(thread.id, next);
        // The Thread the host stored is authoritative: drawing it at once keeps
        // the sidebar's icon and the footer's line on the directory that stuck.
        workspaceStore.getState().applyThread(updated);
        setCwdFailure(undefined);
      } catch (reason) {
        if (
          currentThread.current?.id === thread.id &&
          currentThread.current.cwd === thread.cwd
        ) {
          setCwdFailure({
            threadId: thread.id,
            cwd: thread.cwd,
            message: messageFrom(reason),
          });
        }
      }
    },
    [thread],
  );

  const refresh = useCallback((): void => {
    if (thread !== undefined)
      void refreshProject(queryClient, thread.projectId);
  }, [queryClient, thread]);

  return {
    git: query.data,
    error: query.isError ? messageFrom(query.error) : undefined,
    refreshing: query.isFetching,
    refresh,
    cwdError:
      cwdFailure !== undefined &&
      cwdFailure.threadId === id &&
      cwdFailure.cwd === cwd
        ? cwdFailure.message
        : undefined,
    setCwd,
  };
};
