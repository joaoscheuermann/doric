import { useQuery } from '@tanstack/react-query';
import { pendingReadInterval, readRetry } from 'desktop-reads';

import { gitKeys } from '../changes/store.js';
import { gitClient } from '../state.js';
import { unbound } from './use-thread-git.js';

/** A file's comparison is fetched only after opening its diff tab. */
export const useFileDiff = (
  projectId: string,
  repository: string,
  path: string,
) =>
  useQuery({
    ...readRetry,
    queryKey: gitKeys.fileDiff(projectId, repository, path),
    queryFn: () =>
      (gitClient()?.store.api() ?? unbound()).fileDiff(
        projectId,
        repository,
        path,
      ),
    refetchInterval: (query) =>
      query.state.status === 'error'
        ? false
        : pendingReadInterval(query.state.data),
  });
