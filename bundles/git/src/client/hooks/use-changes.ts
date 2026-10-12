import { useEffect, useState } from 'react';

import type { ChangesObservation } from '../../contracts/index.js';
import { gitClient } from '../state.js';

const idle: ChangesObservation = {
  read: { status: 'idle' },
  decorations: new Map(),
  fetching: false,
};

/**
 * The changes read of one Project and working directory while this surface
 * shows it: idle without a Project, as the panel and footer were.
 */
export const useChanges = (
  projectId: string | undefined,
  cwd: string | undefined,
): ChangesObservation => {
  const [state, setState] = useState<ChangesObservation>(idle);
  useEffect(() => {
    const client = gitClient();
    if (projectId === undefined || client === undefined) {
      setState(idle);
      return;
    }
    const observation = client.store.observeChanges(
      { projectId, ...(cwd === undefined ? {} : { cwd }) },
      setState,
    );
    return () => observation.dispose();
  }, [projectId, cwd]);
  return state;
};
