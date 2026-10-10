import { useQueries, useQueryClient } from '@tanstack/react-query';
import { toast } from 'desktop-ui/sonner';
import { useEffect } from 'react';

import { messageFrom } from '../../../domain/errors.js';
import { type Project, upsert } from '../../../domain/workspace.js';
import { workspaceTabsStore } from '../../../stores/workspace-tabs.js';
import { api } from '../../api/provisional-api.js';
import type { Terminal } from '../domain/terminals.js';

const key = (projectId: string) => ['terminals', projectId] as const;

/** Project watches keep every visible thread's terminals current, even before its conversation opens. */
export function useTerminals(projects: readonly Project[]) {
  const client = useQueryClient();
  const ids = projects.map((project) => project.id).join(',');
  const queries = useQueries({
    queries: projects.map((project) => ({
      queryKey: key(project.id),
      queryFn: () => api.terminals.list(project.id),
      enabled: false,
    })),
  });
  useEffect(() => {
    const stops = ids
      .split(',')
      .filter(Boolean)
      .map((projectId) =>
        api.terminals.watchProject(projectId, (update) => {
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
    return () => stops.forEach((stop) => void stop());
  }, [client, ids]);
  return {
    items: queries.flatMap((query) => query.data ?? []),
    create: async (threadId: string) => {
      try {
        const terminal = await api.terminals.create(threadId);
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
      void api.terminals
        .stop(id)
        .catch((error: unknown) => toast.error(messageFrom(error)));
    },
  };
}
