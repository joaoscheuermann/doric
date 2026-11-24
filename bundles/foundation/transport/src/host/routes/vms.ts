import express, { type Router } from 'express';

import { sendAnswer } from '../api/answer.js';
import { hostOperations } from '../api/operations/host.js';
import type { TransportPorts } from '../api/ports.js';
import { handleHttpError } from '../errors.js';
import { routeInput } from './input.js';

/** The routes observing the sandbox provider's running machines. */
export const createVmsRouter = (
  ports: Pick<TransportPorts, 'tools' | 'resources' | 'sandbox' | 'runtime'>,
): Router => {
  const router = express.Router();
  const operations = hostOperations(ports);

  router.get('/', async (request, response) => {
    sendAnswer(response, await operations.vms(routeInput(request)));
  });

  router.get('/:id/ssh', async (request, response) => {
    response.set('Cache-Control', 'no-store');
    sendAnswer(response, await operations.vmSsh(routeInput(request)));
  });

  router.use(handleHttpError);
  return router;
};
