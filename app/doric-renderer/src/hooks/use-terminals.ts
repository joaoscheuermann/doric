import { useQueries, useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { toast } from 'sonner';

import type { Terminal } from '@/domain/terminals';
import { messageFrom, type Project, upsert } from '@/domain/workspace';
import { workspaceTabsStore } from '@/stores/workspace-tabs';

const key = (projectId: string) => ['terminals', projectId] as const;

/** Project watches keep every visible thread's terminals current, even before its conversation opens. */
export function useTerminals(projects: readonly Project[]) {
  const client = useQueryClient();
  const ids = projects.map((project) => project.id).join(',');
  const queries = useQueries({
    queries: projects.map((project) => ({
      queryKey: key(project.id),
      queryFn: () => window.doric.terminals.list(project.id),
      enabled: false,
    })),
  });
  useEffect(() => {
    const stops = ids
      .split(',')
      .filter(Boolean)
      .map((projectId) =>
        window.doric.terminals.watchProject(projectId, (update) => {
          if (update.kind === 'error') {
            toast.error(update.message);
            return;
          }
          client.setQueryData<readonly Terminal[]>(
            key(projectId),
            (previous = []) => {
              if (update.kind === 'snapshot') {
                for (const terminal of previous) {
                  if (!update.terminals.some((item) => item.id === terminal.id))
                    workspaceTabsStore.getState().remove(terminal.id);
                }
                return update.terminals;
              }
              if (update.kind === 'removed') {
                workspaceTabsStore.getState().remove(update.terminalId);
                return previous.filter(
                  (terminal) => terminal.id !== update.terminalId,
                );
              }
              return upsert(previous, update.terminal, 'last');
            },
          );
        }),
      );
    return () => stops.forEach((stop) => stop());
  }, [client, ids]);
  return {
    items: queries.flatMap((query) => query.data ?? []),
    create: async (threadId: string) => {
      try {
        const terminal = await window.doric.terminals.create(threadId);
        client.setQueryData<readonly Terminal[]>(
          key(terminal.projectId),
          (items = []) => upsert(items, terminal, 'last'),
        );
        workspaceTabsStore.getState().manual(threadId, terminal.id);
      } catch (error) {
        toast.error(messageFrom(error));
      }
    },
    stop: (id: string) => {
      void window.doric.terminals
        .stop(id)
        .catch((error: unknown) => toast.error(messageFrom(error)));
    },
  };
}
