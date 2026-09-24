import { Router } from 'express';

import { ConfigUpdateSchema, publicConfig } from '../lib/config/schema.js';
import type { ConfigService } from '../lib/config/service.js';
import { sendError } from '../lib/http/errors.js';

/** Exposes the singleton configuration without its write-only GitHub token. */
export const createConfigRouter = (service: ConfigService): Router => {
  const router = Router();

  router.get('/', (_request, response) =>
    response.json(publicConfig(service.current().snapshot)),
  );

  router.put('/', async (request, response) => {
    const parsed = ConfigUpdateSchema.safeParse(request.body);

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
      response.json(publicConfig(await service.replace(parsed.data)));
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
