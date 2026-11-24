import { Router } from 'express';

import { sendAnswer } from '../api/answer.js';
import { configOperations } from '../api/operations/config.js';
import type { TransportPorts } from '../api/ports.js';
import { routeInput } from './input.js';

/** Exposes the singleton configuration through `configOperations`. */
export const createConfigRouter = (
  configuration: TransportPorts['configuration'],
): Router => {
  const router = Router();
  const operations = configOperations({ configuration });

  router.get('/', async (request, response) => {
    sendAnswer(response, await operations.current(routeInput(request)));
  });

  router.put('/', async (request, response) => {
    sendAnswer(response, await operations.replace(routeInput(request)));
  });

  return router;
};
