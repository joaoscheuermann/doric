import { Router } from 'express';
import type { Resources } from 'resources/contracts';

/**
 * Reads the machine the host runs on, through the `resources` bundle
 * (`resources/v1.host()`, stage 10 §4). It holds no lease: an answer is
 * always available, so the monitor can poll it without a Project being
 * involved.
 */
export const createResourcesRouter = (resources: () => Resources): Router => {
  const router = Router();

  router.get('/', async (_request, response) => {
    response.set('Cache-Control', 'no-store');
    response.json(await resources().host());
  });

  return router;
};
