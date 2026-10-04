import { Router } from 'express';

import { ConfigInputSchema } from '../lib/config/schema.js';
import {
  ConfigCredentialError,
  type ConfigService,
  ConfigToolError,
} from '../lib/config/service.js';
import { sendError } from '../lib/http/errors.js';

/**
 * Exposes the singleton configuration. It holds no secret of its own: it names
 * credentials by id, so what it answers is what it accepts.
 */
export const createConfigRouter = (service: ConfigService): Router => {
  const router = Router();

  router.get('/', (_request, response) =>
    response.json(service.current().snapshot),
  );

  router.put('/', async (request, response) => {
    const parsed = ConfigInputSchema.safeParse(request.body);

    if (!parsed.success) {
      sendError(
        response,
        422,
        'invalid_config',
        'The Doric configuration is invalid.',
      );

      return;
    }

    try {
      response.json(await service.replace(parsed.data));
    } catch (error) {
      if (
        error instanceof ConfigCredentialError ||
        error instanceof ConfigToolError
      ) {
        sendError(response, 422, 'invalid_config', error.message);

        return;
      }

      sendError(
        response,
        503,
        'configuration_rejected',
        'The Doric configuration could not be activated.',
      );
    }
  });

  return router;
};
