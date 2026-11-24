import { Router } from 'express';

import { sendAnswer } from '../api/answer.js';
import { providerOperations } from '../api/operations/providers.js';
import type { TransportPorts } from '../api/ports.js';
import { routeInput } from './input.js';

/** The provider kinds and draft model catalogs, through `providerOperations`. */
export const createProvidersRouter = (
  models: TransportPorts['models'],
): Router => {
  const router = Router();
  const operations = providerOperations({ models });

  router.get('/kinds', async (request, response) => {
    sendAnswer(response, await operations.kinds(routeInput(request)));
  });

  router.post('/models', async (request, response) => {
    sendAnswer(response, await operations.models(routeInput(request)));
  });

  return router;
};
