import { messageFrom, type Thread } from '@/domain/workspace';
import { refreshProject } from '@/queries/project-refresh';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';

/** Branch reads are scoped to the directory and live only while the picker is open. */
export function useBranches(thread: Thread) {
  const client = useQueryClient();
  const key = ['thread', thread.id, 'git', thread.cwd, 'branches'];
  const query = useQuery({
    queryKey: key,
    queryFn: () => window.doric.threads.branches(thread.id),
    meta: { projectId: thread.projectId },
    retry: false,
  });
  const mutation = useMutation({
    mutationFn: (branch: string) =>
      window.doric.threads.switchBranch(thread.id, branch, thread.cwd),
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
