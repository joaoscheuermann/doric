import {
  type CredentialKind,
  credentialFieldsMessage,
  credentialFieldsSatisfied,
  credentialKinds,
} from 'bundle/contracts';
import { z } from 'zod';

// The one field rule of every kind lives beside `secrets/v1` (decision S-6),
// so the route schemas below and the `secrets/v1` provider derive from it.
export {
  type CredentialField,
  type CredentialFieldSet,
  type CredentialKind,
  type CredentialValues,
  credentialFieldNames,
  credentialFields,
  credentialFieldsMessage,
  credentialFieldsSatisfied,
  credentialKinds,
} from 'bundle/contracts';

/** A stored credential with its secret decrypted for host use. */
export interface Credential {
  readonly id: string;
  readonly kind: CredentialKind;
  readonly name: string;
  readonly username?: string;
  readonly email?: string;
  readonly secret?: string;
}

/**
 * The API view of a credential. The secret itself never leaves the host: the
 * value is replaced by whether there is one to use.
 */
export interface PublicCredential {
  readonly id: string;
  readonly kind: CredentialKind;
  readonly name: string;
  readonly username?: string;
  readonly email?: string;
  readonly hasSecret: boolean;
}

export const publicCredential = ({
  id,
  kind,
  name,
  username,
  email,
  secret,
}: Credential): PublicCredential => ({
  id,
  kind,
  name,
  ...(username ? { username } : {}),
  ...(email ? { email } : {}),
  hasSecret: secret !== undefined && secret !== '',
});

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

/**
 * The `POST /credentials` body. A create names the kind's fields and nothing
 * else, and a field the kind forbids is rejected by the same rule that the
 * service applies to a stored row.
 */
export const CredentialCreateSchema = z
  .object({
    kind: z.enum(credentialKinds),
    name,
    username: username.optional(),
    email: email.optional(),
    secret: secret.optional(),
  })
  .strict()
  .superRefine((input, context) => {
    if (!credentialFieldsSatisfied(input.kind, input))
      context.addIssue({
        code: 'custom',
        message: credentialFieldsMessage(input.kind),
      });
  });

/** `''` clears a stored field, `null` keeps it, and a value sets it. */
const clearing = <Schema extends z.ZodType>(schema: Schema) =>
  z.union([schema, z.literal(''), z.null()]).optional();

/**
 * The `PATCH /credentials/:id` body. `kind` is accepted only so a change to it
 * can be rejected with a named error rather than an unknown-field failure, and
 * every field follows the one clear/keep/set rule. The service checks the
 * merged result against the stored kind's field set.
 */
export const CredentialUpdateSchema = z
  .object({
    kind: z.enum(credentialKinds).optional(),
    name: name.optional(),
    username: clearing(username),
    email: clearing(email),
    secret: clearing(secret),
  })
  .strict();

export type CredentialCreate = z.output<typeof CredentialCreateSchema>;

export type CredentialUpdate = z.output<typeof CredentialUpdateSchema>;
