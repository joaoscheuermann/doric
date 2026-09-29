import { z } from 'zod';

/** The closed set of credential kinds. A kind fixes the field set below. */
export const credentialKinds = [
  'API_TOKEN',
  'USERNAME_PASSWORD',
  'GIT',
] as const;

export type CredentialKind = (typeof credentialKinds)[number];

/** The columns a credential row may carry. */
export const credentialFieldNames = ['username', 'email', 'secret'] as const;

export type CredentialField = (typeof credentialFieldNames)[number];

export interface CredentialValues {
  readonly username?: string;
  readonly email?: string;
  readonly secret?: string;
}

export interface CredentialFieldSet {
  readonly required: readonly CredentialField[];
  readonly optional: readonly CredentialField[];
}

/**
 * The one rule every kind derives from, and the reason `credential` carries no
 * cross-column CHECK: a required field must be present, and every other field
 * must be absent. `API_TOKEN` is authentication (a provider key or a GitHub
 * token); `USERNAME_PASSWORD` is authentication with a name; `GIT` is identity
 * alone, which is why it holds no secret at all.
 */
const fieldSets: Record<CredentialKind, CredentialFieldSet> = {
  API_TOKEN: { required: ['secret'], optional: [] },
  USERNAME_PASSWORD: { required: ['username', 'secret'], optional: [] },
  GIT: { required: ['username', 'email'], optional: [] },
};

export const credentialFields = (kind: CredentialKind): CredentialFieldSet =>
  fieldSets[kind];

/** Whether these values satisfy the kind's required and forbidden fields. */
export const credentialFieldsSatisfied = (
  kind: CredentialKind,
  values: CredentialValues,
): boolean => {
  const { required, optional } = credentialFields(kind);
  const allowed = new Set<CredentialField>([...required, ...optional]);

  return (
    required.every((field) => values[field] !== undefined) &&
    credentialFieldNames.every(
      (field) => values[field] === undefined || allowed.has(field),
    )
  );
};

/** The readable statement of that rule, used by the API's rejection messages. */
export const credentialFieldsMessage = (kind: CredentialKind): string => {
  const { required, optional } = credentialFields(kind);
  const carries =
    optional.length === 0
      ? 'and carries no other field'
      : `and may also carry ${optional.join(', ')}`;

  return `A ${kind} credential requires ${required.join(', ')} ${carries}.`;
};

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
