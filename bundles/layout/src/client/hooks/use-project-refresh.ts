import { useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';

import {
  type ActivityTerminal,
  projectActivity,
} from '../domain/project-refresh.js';
import type { Project, Thread } from '../domain/workspace.js';
import { refreshProject } from '../queries/project-refresh.js';
import { useConnectionStatus } from './use-connection-status.js';

/** The terminal fields the refresh policy reads. */
export type RefreshTerminal = ActivityTerminal & { readonly projectId: string };

/**
 * One Project refresh policy, independent of the selected conversation's
 * rendering. Its first trigger, a sandbox-writing tool completion in any held
 * conversation, arrives through chat's `onSandboxActivityHook` (D9-10), which
 * the layout's activation subscribes to.
 */
export function useProjectRefresh({
  project,
  thread,
  threads,
  terminals,
  visible,
}: {
  project: Project | undefined;
  thread: Thread | undefined;
  threads: readonly Thread[];
  terminals: readonly RefreshTerminal[];
  visible: boolean;
}) {
  const client = useQueryClient();
  const connection = useConnectionStatus();
  const projectId = project?.id;
  const activity = projectActivity(
    threads,
    terminals.filter((terminal) => terminal.projectId === projectId),
  );

  // The extra dependencies are refresh triggers: the effect must re-run when the
  // selected Project's state, the selected Thread, the panel's visibility, or the
  // Project's activity changes, even though the body reads only the client, the
  // Project id, and the connection.
  // biome-ignore lint/correctness/useExhaustiveDependencies: extra entries are deliberate refresh triggers rather than values the body reads
  useEffect(() => {
    if (projectId && connection === 'connected')
      void refreshProject(client, projectId);
  }, [
    client,
    projectId,
    project?.state,
    thread?.id,
    thread?.cwd,
    visible,
    connection,
    activity,
  ]);

  useEffect(() => {
    if (!projectId || !visible || connection !== 'connected') return;
    const refresh = () => {
      if (document.visibilityState === 'visible')
        void refreshProject(client, projectId);
    };
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', refresh);
    // No filesystem watcher exists. This bounded, visible-only fallback also
    // covers external edits and Threads whose conversations were never opened.
    const interval = setInterval(() => {
      if (document.visibilityState === 'visible')
        void refreshProject(client, projectId, true);
    }, 15_000);
    return () => {
      window.removeEventListener('focus', refresh);
      document.removeEventListener('visibilitychange', refresh);
      clearInterval(interval);
    };
  }, [client, connection, projectId, visible]);
}
