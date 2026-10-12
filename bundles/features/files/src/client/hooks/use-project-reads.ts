import { useEffect } from 'react';

import { filesClient } from '../state.js';

/**
 * Registers this surface's reads of a Project with the refresh coordinator
 * while it is mounted: it is shown for as long as it is mounted.
 */
export const useProjectReads = (projectId: string | undefined): void => {
  useEffect(() => {
    const client = filesClient();
    if (projectId === undefined || client === undefined) return;
    const registration = client.coordinator.register({
      projectId,
      active: () => true,
      refresh: ({ periodic }) => client.store.refresh(projectId, periodic),
    });
    return () => registration.dispose();
  }, [projectId]);
};
