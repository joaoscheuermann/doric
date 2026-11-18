import type { Services } from 'bundle/contracts';

let current: Services | undefined;

/**
 * The workspace's activation services. Persistent work (watches, the selection
 * route, commands from the sidebar) uses these, never an element's services,
 * which `ui.dispose` releases (D9-17).
 */
export const setWorkspaceServices = (services: Services | undefined): void => {
  current = services;
};

export const workspaceServices = (): Services => {
  if (current === undefined) {
    throw new Error('The workspace bundle is not active.');
  }
  return current;
};
