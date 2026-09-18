import { Router } from 'express';

import { ConfigInputSchema } from '../lib/config.js';
import type { ConfigService } from '../lib/config-service.js';
import { sendError } from '../lib/http.js';

/** Exposes the credential-free singleton configuration without changing its schema. */
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
    } catch {
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
