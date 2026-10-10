import { useQuery } from '@tanstack/react-query';

import { queryKeys } from '../../../queries/keys.js';
import { api } from '../../api/provisional-api.js';
import {
  pendingReadInterval,
  sandboxReadRetry,
} from '../domain/sandbox-reads.js';

/** A file's comparison is fetched only after opening its diff tab. */
export const useFileDiff = (
  projectId: string,
  repository: string,
  path: string,
) =>
  useQuery({
    ...sandboxReadRetry,
    queryKey: queryKeys.files.fileDiff(projectId, repository, path),
    queryFn: () => api.projects.fileDiff(projectId, repository, path),
    refetchInterval: (query) =>
      query.state.status === 'error'
        ? false
        : pendingReadInterval(query.state.data),
  });
