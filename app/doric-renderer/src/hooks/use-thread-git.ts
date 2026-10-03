/**
 * One Thread's git summary, kept fresh for the conversation footer.
 *
 * The summary is the host's reading of the Thread's working directory, so it is
 * refreshed whenever that directory may have moved under the reader: when the
 * Thread is shown, when its cwd changes (it arrives in an `updated` Thread),
 * when one of its prompts settles, when the window regains focus, and every few
 * seconds while the selected Thread is running — stopping as soon as it is ready.
 */

import type { ThreadGit } from '@/domain/thread-git';
import { messageFrom, type Thread } from '@/domain/workspace';
import { queryKeys } from '@/queries/keys';
import { workspaceStore } from '@/stores/workspace';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';

/** How often a running Thread's summary is reread while its prompt runs. */
const RUNNING_REFRESH_MS = 3000;

export type ThreadGitState = {
  /** The host's summary, absent until the first read lands. */
  readonly git?: ThreadGit;
  /** Why the summary could not be read; the footer still shows the path. */
  readonly error?: string;
  /** The host's refusal of the last `setCwd`, shown beside the field. */
  readonly cwdError?: string;
  /** Moves the Thread's working directory; a refusal is reported, not thrown. */
  readonly setCwd: (cwd: string) => Promise<void>;
};

export const useThreadGit = (thread: Thread | undefined): ThreadGitState => {
  const queryClient = useQueryClient();
  const [cwdError, setCwdError] = useState<string>();
  const id = thread?.id;
  const cwd = thread?.cwd;
  const state = thread?.state;

  const query = useQuery({
    queryKey: queryKeys.threadGit(id),
    queryFn: () => window.doric.threads.git(id as string),
    enabled: id !== undefined,
    gcTime: 0,
  });

  const refresh = useCallback((): void => {
    if (id === undefined) return;
    void queryClient.invalidateQueries({ queryKey: queryKeys.threadGit(id) });
  }, [id, queryClient]);

  // A cwd that arrives in an `updated` Thread is a new directory to summarize.
  const previousCwd = useRef(cwd);
  useEffect(() => {
    if (previousCwd.current === cwd) return;
    previousCwd.current = cwd;
    refresh();
  }, [cwd, refresh]);

  // A prompt settling is when the working directory may have changed under it.
  const previousState = useRef(state);
  useEffect(() => {
    if (previousState.current === state) return;
    previousState.current = state;
    refresh();
  }, [refresh, state]);

  // The reader returning to the window may find the directory changed elsewhere.
  useEffect(() => {
    const onFocus = (): void => refresh();
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [refresh]);

  // While a prompt runs, the summary is polled; a ready Thread stops it.
  useEffect(() => {
    if (state !== 'running') return;
    const timer = setInterval(refresh, RUNNING_REFRESH_MS);
    return () => clearInterval(timer);
  }, [refresh, state]);

  const setCwd = useCallback(
    async (next: string): Promise<void> => {
      if (thread === undefined) return;
      try {
        const updated = await window.doric.threads.setCwd(thread.id, next);
        // The Thread the host stored is authoritative: drawing it at once keeps
        // the sidebar's icon and the footer's line on the directory that stuck.
        workspaceStore.getState().applyThread(updated);
        setCwdError(undefined);
      } catch (reason) {
        setCwdError(messageFrom(reason));
      }
    },
    [thread],
  );

  return {
    git: query.data,
    error: query.isError ? messageFrom(query.error) : undefined,
    cwdError,
    setCwd,
  };
};
