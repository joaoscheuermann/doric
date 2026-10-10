import { useEffect } from 'react';

import { gitClient } from '../state.js';

/**
 * Registers this surface's reads of a Project with the files refresh
 * coordinator while it is mounted: it is shown for as long as it is mounted.
 */
export const useProjectReads = (projectId: string | undefined): void => {
  useEffect(() => {
    const client = gitClient();
    if (projectId === undefined || client === undefined) return;
    const refresh = client.refresh();
    if (refresh === undefined) return;
    const registration = refresh.register({
      projectId,
      active: () => true,
      refresh: ({ periodic }) => client.store.refresh(projectId, periodic),
    });
    return () => registration.dispose();
  }, [projectId]);
};
