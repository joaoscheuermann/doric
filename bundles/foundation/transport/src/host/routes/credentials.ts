import {
  type CredentialCreate,
  type CredentialDescription,
  credentialFieldsSatisfied,
  credentialKindSchema,
  isContractError,
  type Secrets,
} from 'bundle/contracts';
import { type Response, Router } from 'express';
import { z } from 'zod';

import { sendError } from '../errors.js';
import { conflict, missing, validateId } from './input.js';

/*
 * The route bodies of agents/doric's credentials/kind.ts, unchanged: the
 * field rule lives beside `secrets/v1`, and these schemas only add the HTTP
 * limits (lengths, email, no line break in a secret). A kind is checked
 * against the kinds the host registers, so a kind nothing registers is
 * refused as the body's own mismatch.
 */

const name = z.string().trim().min(1).max(128);
const username = z.string().trim().min(1).max(128);
const email = z.string().trim().max(256).pipe(z.email());
const secret = z
  .string()
  .min(1)
  .max(512)
  .refine((value) => !/[\r\n]/u.test(value), {
    message: 'A credential secret cannot contain line breaks.',
  });

/** The `POST /credentials` body: the kind's fields and nothing else. */
export const CredentialCreateSchema = z
  .object({
    kind: credentialKindSchema,
    name,
    username: username.optional(),
    email: email.optional(),
    secret: secret.optional(),
  })
  .strict();

/** `''` clears a stored field, `null` keeps it, and a value sets it. */
const clearing = <Schema extends z.ZodType>(schema: Schema) =>
  z.union([schema, z.literal(''), z.null()]).optional();

/**
 * The `PATCH /credentials/:id` body. `kind` is accepted only so a change to it
 * is refused with a named error rather than an unknown-field failure.
 */
export const CredentialUpdateSchema = z
  .object({
    kind: credentialKindSchema.optional(),
    name: name.optional(),
    username: clearing(username),
    email: clearing(email),
    secret: clearing(secret),
  })
  .strict();

/**
 * Named credentials. The routes stay unauthenticated like the rest, so the
 * load-bearing control is the response shape: `secrets/v1` describes whether
 * a secret exists and never the secret itself.
 */
export const createCredentialsRouter = (secrets: Secrets): Router => {
  const router = Router();

  router.get('/', async (_request, response) => {
    response.json(await secrets.list());
  });

  router.post('/', async (request, response) => {
    const input = CredentialCreateSchema.safeParse(request.body ?? {});
    if (!input.success || !(await fitsKind(secrets, input.data))) {
      sendError(
        response,
        422,
        'invalid_credential',
        'The credential does not match its kind.',
      );
      return;
    }

    const result = await writeCredentials(
      () => secrets.create(input.data),
      response,
    );
    if (result === undefined) return;
    response.status(201).json(result);
  });

  router.use('/:id', validateId('credential'));

  router.patch('/:id', async (request, response) => {
    const input = CredentialUpdateSchema.safeParse(request.body ?? {});
    if (!input.success || !(await namesRegisteredKind(secrets, input.data))) {
      sendError(
        response,
        422,
        'invalid_credential',
        'The credential does not match its kind.',
      );
      return;
    }

    const result = await writeCredentials(
      () => secrets.update({ id: request.params.id }, input.data),
      response,
    );
    if (result === undefined) return;
    response.json(result);
  });

  router.delete('/:id', async (request, response) => {
    const result = await secrets.delete({ id: request.params.id });
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

/** Whether a registered kind accepts the create body's fields. */
const fitsKind = async (
  secrets: Secrets,
  input: CredentialCreate,
): Promise<boolean> => {
  const definition = (await secrets.kinds()).find(
    ({ id }) => id === input.kind,
  );

  return (
    definition !== undefined && credentialFieldsSatisfied(definition, input)
  );
};

/** Whether an update names no kind, or a kind a registration holds. */
const namesRegisteredKind = async (
  secrets: Secrets,
  input: { readonly kind?: string },
): Promise<boolean> =>
  input.kind === undefined ||
  (await secrets.kinds()).some(({ id }) => id === input.kind);

/**
 * Runs one create or update and answers the shared failure statuses. A refusal
 * names the kind's field set, and an unconfigured key is the host's problem,
 * not the caller's. Any other failure reaches the final error handler.
 */
const writeCredentials = async (
  write: () => Promise<CredentialDescription>,
  response: Response,
): Promise<CredentialDescription | undefined> => {
  try {
    return await write();
  } catch (error) {
    if (!isContractError(error)) throw error;
    switch (error.code) {
      case 'credential_invalid':
      case 'unknown_kind':
        sendError(response, 422, 'invalid_credential', error.message);
        return undefined;
      case 'credential_missing':
        missing(response, 'credential');
        return undefined;
      case 'credential_kind_immutable':
        conflict(response, 'credential', 'kind_immutable');
        return undefined;
      case 'credential_name_taken':
        conflict(response, 'credential', 'name_taken');
        return undefined;
      case 'credential_storage_unavailable':
        sendError(
          response,
          503,
          'credential_storage_unavailable',
          'The host cannot store credential secrets.',
        );
        return undefined;
      default:
        throw error;
    }
  }
};
