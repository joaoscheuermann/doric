import { Router } from 'express';

import { providerKinds } from 'llms';

/**
 * The provider kinds this host can configure. The bodies are the llms catalog
 * unchanged, so a settings surface configures every kind that package can build
 * without knowing any of them.
 */
export const createProvidersRouter = (): Router => {
  const router = Router();

  router.get('/kinds', (_request, response) =>
    response.json({ kinds: providerKinds }),
  );

  return router;
};
