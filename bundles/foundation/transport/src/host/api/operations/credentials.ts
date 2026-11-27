import {
  type CredentialCreate,
  type CredentialDescription,
  credentialFieldsSatisfied,
  credentialKindSchema,
  isContractError,
} from 'bundle/contracts';
import { conflictError, notFoundError } from 'runtime/contracts';
import { z } from 'zod';

import type { ApiAnswer, RouteInput } from '../answer.js';
import { ok, refused } from '../input.js';
import type { TransportPorts } from '../ports.js';

type Op<V> = (input: RouteInput) => Promise<ApiAnswer<V>>;
type Secrets = TransportPorts['secrets'];

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

const invalidCredential = refused({
  status: 422,
  code: 'invalid_credential',
  message: 'The credential does not match its kind.',
});

/**
 * The `/credentials` route bodies over the ports. The routes stay
 * unauthenticated like the rest, so the load-bearing control is the response
 * shape: `secrets/v1` describes whether a secret exists and never the secret
 * itself.
 */
export const credentialOperations = ({
  secrets,
}: Pick<TransportPorts, 'secrets'>): {
  /** `GET /credentials`. */
  readonly list: Op<readonly CredentialDescription[]>;
  /** `POST /credentials` → 201. */
  readonly create: Op<CredentialDescription>;
  /** `PATCH /credentials/:id`. */
  readonly update: Op<CredentialDescription>;
  /** `DELETE /credentials/:id` → 204. */
  readonly remove: Op<undefined>;
} => ({
  list: async () => ok(await secrets.list()),
  create: async ({ body }) => {
    const input = CredentialCreateSchema.safeParse(body ?? {});
    if (!input.success || !(await fitsKind(secrets, input.data))) {
      return invalidCredential;
    }

    return writeCredentials(() => secrets.create(input.data), 201);
  },
  update: async ({ params, body }) => {
    const input = CredentialUpdateSchema.safeParse(body ?? {});
    if (!input.success || !(await namesRegisteredKind(secrets, input.data))) {
      return invalidCredential;
    }

    return writeCredentials(
      () => secrets.update({ id: params.id ?? '' }, input.data),
      200,
    );
  },
  remove: async ({ params }) => {
    const result = await secrets.delete({ id: params.id ?? '' });
    if (result === 'missing') return refused(notFoundError('credential'));
    if (result === 'referenced') {
      return refused(conflictError('credential', 'referenced'));
    }
    return ok(undefined, 204);
  },
});

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
 * not the caller's. Any other failure rejects.
 */
const writeCredentials = async (
  write: () => Promise<CredentialDescription>,
  status: 200 | 201,
): Promise<ApiAnswer<CredentialDescription>> => {
  try {
    return ok(await write(), status);
  } catch (error) {
    if (!isContractError(error)) throw error;
    switch (error.code) {
      case 'credential_invalid':
      case 'unknown_kind':
        return refused({
          status: 422,
          code: 'invalid_credential',
          message: error.message,
        });
      case 'credential_missing':
        return refused(notFoundError('credential'));
      case 'credential_kind_immutable':
        return refused(conflictError('credential', 'kind_immutable'));
      case 'credential_name_taken':
        return refused(conflictError('credential', 'name_taken'));
      case 'credential_storage_unavailable':
        return refused({
          status: 503,
          code: 'credential_storage_unavailable',
          message: 'The host cannot store credential secrets.',
        });
      default:
        throw error;
    }
  }
};
