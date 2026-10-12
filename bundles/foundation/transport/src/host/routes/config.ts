import { Router } from 'express';
import type { Configuration } from 'runtime/contracts';

import { sendError } from '../errors.js';

/**
 * Exposes the singleton configuration. It holds no secret of its own: it names
 * credentials by id, so what it answers is what it accepts. `host-config/v1`
 * validates the body (the schema needs the provider kind catalog), and answers
 * an invalid one with the message this route sent before.
 */
export const createConfigRouter = (configuration: Configuration): Router => {
  const router = Router();

  router.get('/', async (_request, response) => {
    response.json(await configuration.current());
  });

  router.put('/', async (request, response) => {
    try {
      const result = await configuration.replace(request.body);

      if (result.status === 'replaced') {
        response.json(result.config);

        return;
      }

      if (result.status === 'invalid') {
        sendError(response, 422, 'invalid_config', result.message);

        return;
      }
    } catch {
      // Any other failure of the replacement is the activation's, as before.
    }

    sendError(
      response,
      503,
      'configuration_rejected',
      'The Doric configuration could not be activated.',
    );
  });

  return router;
};
