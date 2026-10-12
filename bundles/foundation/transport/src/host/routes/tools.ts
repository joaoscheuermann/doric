import type { Tools } from 'bundle/contracts';
import { Router } from 'express';

/**
 * The tools the loaded bundles expose, with the configuration fields each one
 * declares. `tools/v1` lists the active generation's tools; their metadata is
 * kernel-local, so the read executes nothing.
 */
export const createToolsRouter = (tools: Tools): Router => {
  const router = Router();

  router.get('/', async (_request, response) => {
    // Called from another process the list arrives as a promise of the list.
    const registered = await tools.list();

    response.json({
      tools: registered.map(({ tool }) => ({
        name: tool.name,
        description: tool.description,
        settings: tool.settings,
      })),
    });
  });

  return router;
};
