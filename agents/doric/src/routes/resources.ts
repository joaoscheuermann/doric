import { Router } from 'express';

import type { HostResources } from '../lib/workspace/resources.js';

/**
 * Reads the machine the host runs on. It holds no lease: an answer is always
 * available, so the monitor can poll it without a Project being involved. The
 * reader is injected so a test can decide what the host reports.
 */
export const createResourcesRouter = (
  readHost: () => HostResources,
): Router => {
  const router = Router();

  router.get('/', (_request, response) => {
    response.set('Cache-Control', 'no-store');
    response.json(readHost());
  });

  return router;
};
