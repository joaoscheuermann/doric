import { Router } from 'express';

import { sendAnswer } from '../api/answer.js';
import { hostOperations } from '../api/operations/host.js';
import type { TransportPorts } from '../api/ports.js';
import { routeInput } from './input.js';

/**
 * Reads the machine the host runs on, through the `resources` bundle
 * (`resources/v1.host()`, stage 10 §4), by `hostOperations`.
 */
export const createResourcesRouter = (
  ports: Pick<TransportPorts, 'tools' | 'resources' | 'sandbox' | 'runtime'>,
): Router => {
  const router = Router();
  const operations = hostOperations(ports);

  router.get('/', async (request, response) => {
    response.set('Cache-Control', 'no-store');
    sendAnswer(response, await operations.resources(routeInput(request)));
  });

  return router;
};
