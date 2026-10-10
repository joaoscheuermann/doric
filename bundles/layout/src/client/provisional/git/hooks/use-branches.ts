import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'desktop-ui/sonner';

import { messageFrom } from '../../../domain/errors.js';
import type { Thread } from '../../../domain/workspace.js';
import { refreshProject } from '../../../queries/project-refresh.js';
import { api } from '../../api/provisional-api.js';
import { pendingReadInterval } from '../../files/domain/sandbox-reads.js';

/** Branch reads are scoped to the directory and live only while the picker is open. */
export function useBranches(thread: Thread) {
  const client = useQueryClient();
  const key = ['thread', thread.id, 'git', thread.cwd, 'branches'];
  const query = useQuery({
    queryKey: key,
    queryFn: () => api.threads.branches(thread.id),
    meta: { projectId: thread.projectId },
    retry: false,
    refetchInterval: (query) =>
      pendingReadInterval(
        query.state.data?.status === undefined
          ? undefined
          : { status: query.state.data.status },
      ),
  });
  const mutation = useMutation({
    mutationFn: (branch: string) =>
      api.threads.switchBranch(thread.id, branch, thread.cwd),
    onSuccess: async (value) => {
      client.setQueryData(key, value);
      await refreshProject(client, thread.projectId);
    },
    onError: (error) => {
      toast.error(messageFrom(error));
      void query.refetch();
    },
  });
  return { query, mutation };
}
