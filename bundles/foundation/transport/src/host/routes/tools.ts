import { Router } from 'express';

import { sendAnswer } from '../api/answer.js';
import { hostOperations } from '../api/operations/host.js';
import type { TransportPorts } from '../api/ports.js';
import { routeInput } from './input.js';

/** The tools the loaded bundles expose, through `hostOperations`. */
export const createToolsRouter = (
  ports: Pick<TransportPorts, 'tools' | 'resources' | 'sandbox' | 'runtime'>,
): Router => {
  const router = Router();
  const operations = hostOperations(ports);

  router.get('/', async (request, response) => {
    sendAnswer(response, await operations.tools(routeInput(request)));
  });

  return router;
};
