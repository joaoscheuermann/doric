import { useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';

import {
  changedSandboxProjects,
  projectActivity,
} from '@/domain/project-refresh';
import type { Terminal } from '@/domain/terminals';
import type { Project, Thread } from '@/domain/workspace';
import { useConnectionStatus } from '@/hooks/use-connection-status';
import { refreshProject } from '@/queries/project-refresh';
import { threadChatsStore } from '@/stores/thread-chats';

/** One Project refresh policy, independent of the selected conversation's rendering. */
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
  terminals: readonly Terminal[];
  visible: boolean;
}) {
  const client = useQueryClient();
  const connection = useConnectionStatus();
  const projectId = project?.id;
  const activity = projectActivity(
    threads,
    terminals.filter((terminal) => terminal.projectId === projectId),
  );

  useEffect(
    () =>
      threadChatsStore.subscribe((next, previous) => {
        for (const id of changedSandboxProjects(previous.chats, next.chats)) {
          void refreshProject(client, id);
        }
      }),
    [client],
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
