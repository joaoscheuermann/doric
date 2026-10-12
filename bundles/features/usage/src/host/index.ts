import type { HostContext } from 'bundle/contracts';

import { usageService } from './usage.js';

/** Provides `usage/v1`, the Thread usage read with its capacity filled. */
export const activate = ({ services }: HostContext): void => {
  services.provide(usageService);
};
