import type { WindowDescription } from 'desktop-client/protocol';

import { legacyRootFor } from './root';
import { mountSettings } from './settings';
import { mountWorkspace } from './workspace';

/**
 * Stage 8's mount: the legacy React app, one root per window, chosen by the
 * path the window was opened at. Stage 9 replaces it with the core outlet.
 */
export const legacyMount = (_description: WindowDescription): void => {
  const container = document.getElementById('root') as HTMLElement;
  if (legacyRootFor(location.pathname) === 'settings') {
    mountSettings(container);
    return;
  }
  mountWorkspace(container);
};
