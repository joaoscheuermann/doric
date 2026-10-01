import { Router } from 'express';
import type { Logger } from 'pino';

import { type HttpTransport, providerKinds } from 'llms';

import { readCatalogEntries } from '../lib/config/models.js';
import { ProviderValuesSchema } from '../lib/config/schema.js';
import type { CredentialService } from '../lib/credentials/service.js';
import { sendError } from '../lib/http/errors.js';

export interface CreateProvidersRouterOptions {
  readonly credentials: CredentialService;
  /**
   * The transport a catalog read goes through. Absent uses the host's own, so a
   * test can answer the read without reaching an endpoint.
   */
  readonly transport?: HttpTransport;
  readonly logger: Logger;
}

/**
 * The provider kinds this host can configure. The bodies are the llms catalog
 * unchanged, so a settings surface configures every kind that package can build
 * without knowing any of them.
 *
 * The catalog read is the one provider question a settings surface cannot answer
 * locally: it holds a draft, not a connection, so the host reads the models URL
 * for it — with the credential the draft names, when it names one — and answers
 * what the endpoint said about each model.
 */
export const createProvidersRouter = ({
  credentials,
  logger,
  transport,
}: CreateProvidersRouterOptions): Router => {
  const router = Router();

  router.get('/kinds', (_request, response) =>
    response.json({ kinds: providerKinds }),
  );

  router.post('/models', async (request, response) => {
    const parsed = ProviderValuesSchema.safeParse(request.body);

    if (!parsed.success) {
      sendError(
        response,
        422,
        'invalid_provider',
        'The provider values are invalid.',
      );

      return;
    }

    const read = await readCatalogEntries(parsed.data, {
      credentials,
      logger,
      ...(transport === undefined ? {} : { transport }),
    });

    if (read.status !== 'read') {
      sendError(
        response,
        502,
        'model_catalog_unreadable',
        'The provider model catalog could not be read.',
      );

      return;
    }

    response.json({ models: read.models });
  });

  return router;
};
