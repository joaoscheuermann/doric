import { useQuery } from '@tanstack/react-query';

import { pendingReadInterval, sandboxReadRetry } from '@/domain/sandbox-reads';
import { queryKeys } from '@/queries/keys';

/** A file's comparison is fetched only after opening its diff tab. */
export const useFileDiff = (
  projectId: string,
  repository: string,
  path: string,
) =>
  useQuery({
    ...sandboxReadRetry,
    queryKey: queryKeys.files.fileDiff(projectId, repository, path),
    queryFn: () => window.doric.projects.fileDiff(projectId, repository, path),
    refetchInterval: (query) =>
      query.state.status === 'error'
        ? false
        : pendingReadInterval(query.state.data),
  });
