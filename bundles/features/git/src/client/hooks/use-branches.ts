import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { messageFrom, pendingReadInterval } from 'desktop/reads';
import { toast } from 'desktop/ui/sonner';
import type { Thread } from 'runtime/contracts';

import { gitKeys } from '../changes/store.js';
import { gitClient, settleProjectRefresh } from '../state.js';
import { unbound } from './use-thread-git.js';

const api = () => gitClient()?.store.api() ?? unbound();

/** Branch reads are scoped to the directory and live only while the picker is open. */
export function useBranches(thread: Thread) {
  const client = useQueryClient();
  const key = gitKeys.branches(thread.id, thread.cwd);
  const query = useQuery({
    queryKey: key,
    queryFn: () => api().branches(thread.id),
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
      api().switchBranch(thread.id, branch, thread.cwd),
    onSuccess: async (value) => {
      client.setQueryData(key, value);
      await settleProjectRefresh(thread.projectId);
    },
    onError: (error) => {
      toast.error(messageFrom(error));
      void query.refetch();
    },
  });
  return { query, mutation };
}
