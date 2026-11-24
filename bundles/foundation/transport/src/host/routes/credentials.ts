import { Router } from 'express';

import { sendAnswer } from '../api/answer.js';
import { credentialOperations } from '../api/operations/credentials.js';
import type { TransportPorts } from '../api/ports.js';
import { routeInput, validateId } from './input.js';

export {
  CredentialCreateSchema,
  CredentialUpdateSchema,
} from '../api/operations/credentials.js';

/** Named credentials, through `credentialOperations`. */
export const createCredentialsRouter = (
  secrets: TransportPorts['secrets'],
): Router => {
  const router = Router();
  const operations = credentialOperations({ secrets });

  router.get('/', async (request, response) => {
    sendAnswer(response, await operations.list(routeInput(request)));
  });

  router.post('/', async (request, response) => {
    sendAnswer(response, await operations.create(routeInput(request)));
  });

  router.use('/:id', validateId('credential'));

  router.patch('/:id', async (request, response) => {
    sendAnswer(response, await operations.update(routeInput(request)));
  });

  router.delete('/:id', async (request, response) => {
    sendAnswer(response, await operations.remove(routeInput(request)));
  });

  return router;
};
