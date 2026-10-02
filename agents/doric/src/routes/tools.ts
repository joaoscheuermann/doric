import { Router } from 'express';

import type { ConfigService } from '../lib/config/service.js';

/**
 * The tools the loaded bundles expose, with the configuration fields each one
 * declares. The catalog is the host's: bundles load at runtime, so a settings
 * surface draws the tools it actually has rather than a list it already knows,
 * and it reads each tool's own field descriptors to render that tool's section.
 */
export const createToolsRouter = (service: ConfigService): Router => {
  const router = Router();

  router.get('/', (_request, response) => {
    response.json({
      tools: service.current().catalog.tools.map((factory) => ({
        name: factory.name,
        description: factory.description,
        settings: factory.settings,
      })),
    });
  });

  return router;
};
