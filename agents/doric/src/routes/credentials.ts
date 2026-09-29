import { type Response, Router } from 'express';

import {
  CredentialCreateSchema,
  CredentialUpdateSchema,
  publicCredential,
} from '../lib/credentials/kind.js';
import { MissingKeyError } from '../lib/credentials/secret.js';
import type {
  CredentialService,
  CredentialWrite,
} from '../lib/credentials/service.js';
import { sendError } from '../lib/http/errors.js';
import { conflict, missing, validateId } from './workspace-input.js';

/**
 * Named credentials. The routes stay unauthenticated like the rest, so the
 * load-bearing control is the response shape: `publicCredential` answers whether
 * a secret exists and never the secret itself.
 */
export const createCredentialsRouter = (
  credentials: CredentialService,
): Router => {
  const router = Router();

  router.get('/', (_request, response) =>
    response.json(credentials.list().map(publicCredential)),
  );

  router.post('/', async (request, response) => {
    const input = CredentialCreateSchema.safeParse(request.body ?? {});
    if (!input.success) {
      sendError(
        response,
        422,
        'invalid_credential',
        'The credential does not match its kind.',
      );
      return;
    }

    const result = await writeCredentials(
      () => credentials.create(input.data),
      response,
    );
    if (result === undefined) return;
    response.status(201).json(result);
  });

  router.use('/:id', validateId('credential'));

  router.patch('/:id', async (request, response) => {
    const input = CredentialUpdateSchema.safeParse(request.body ?? {});
    if (!input.success) {
      sendError(
        response,
        422,
        'invalid_credential',
        'The credential does not match its kind.',
      );
      return;
    }

    const result = await writeCredentials(
      () => credentials.update(request.params.id, input.data),
      response,
    );
    if (result === undefined) return;
    response.json(result);
  });

  router.delete('/:id', async (request, response) => {
    const result = await credentials.remove(request.params.id);
    if (result === 'missing') {
      missing(response, 'credential');
      return;
    }
    if (result === 'referenced') {
      conflict(response, 'credential', 'referenced');
      return;
    }
    response.status(204).end();
  });

  return router;
};

/**
 * Runs one create or update and answers the shared failure statuses. A rejection
 * names the kind's field set, and an unconfigured key is the host's problem, not
 * the caller's.
 */
const writeCredentials = async (
  write: () => Promise<CredentialWrite>,
  response: Response,
) => {
  try {
    const result = await write();
    if (result.status === 'saved') return publicCredential(result.credential);
    if (result.status === 'invalid') {
      sendError(response, 422, 'invalid_credential', result.message);
      return undefined;
    }
    if (result.status === 'missing') {
      missing(response, 'credential');
      return undefined;
    }
    if (result.status === 'immutable') {
      conflict(response, 'credential', 'kind_immutable');
      return undefined;
    }
    conflict(response, 'credential', 'name_taken');
    return undefined;
  } catch (error) {
    if (error instanceof MissingKeyError) {
      sendError(
        response,
        503,
        'credential_storage_unavailable',
        'The host cannot store credential secrets.',
      );
      return undefined;
    }
    throw error;
  }
};
