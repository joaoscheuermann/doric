import type { Services } from 'bundle/contracts';

let current: Services | undefined;

/**
 * The layout's activation services. Persistent work (watches, the selection
 * route, commands from the frame) uses these, never an element's services,
 * which `ui.dispose` releases (D9-17).
 */
export const setLayoutServices = (services: Services | undefined): void => {
  current = services;
};

export const layoutServices = (): Services => {
  if (current === undefined) {
    throw new Error('The layout bundle is not active.');
  }
  return current;
};
