import { z } from 'zod';

import type { CallArg } from '../call.js';
import type { Disposable } from '../context.js';
import { ref } from '../define.js';
import {
  disposableSchema,
  functionSchema,
  type MethodSpecs,
  noInput,
  type StreamListener,
  streamListener,
} from './common.js';

// Shapes refined in stages 2/3 before any provider published a baseline
// (decision S-1). Error codes raised by secrets/v1 and secrets.backend/v1:
//
// - `credential_missing` (`resolve`, `update`): `Credential <id> is not stored.`
// - `credential_invalid` (`create`, `update`): `credentialFieldsMessage(kind)`.
// - `credential_name_taken` (`create`, `update`): another credential has the name.
// - `credential_kind_immutable` (`update`): an update names another kind.
// - `credential_ambiguous` (`resolveByKind`):
//   `More than one <KIND> credential is stored; name the one to use.`
// - `credential_storage_unavailable` (backend `put` without a key):
//   `DORIC_CREDENTIAL_KEY is required to store a credential secret.`
// - `credential_key_required` (backend `list`/`get` at load):
//   `DORIC_CREDENTIAL_KEY is required while a stored credential holds a secret.`
// - `credential_unreadable` (backend decryption): a stored secret is not a
//   supported envelope, or the cipher rejects it.
// - `unknown_kind` (`create`, `update`, `resolve`, `resolveByKind`): no
//   registration the call's generation sees names the kind.
// - `duplicate_credential_kind` (`registerKind`): a registration the call's
//   generation collides with already holds the kind.

/**
 * A credential kind is a registered name. The platform defines the two kinds
 * below; a bundle registers any other with `registerKind`. A stored row of a
 * kind nothing registers stays listable, and resolving it is refused.
 */
export const credentialKindSchema = z.string().regex(/^[A-Z][A-Z0-9_]{1,31}$/);

export type CredentialKind = z.output<typeof credentialKindSchema>;

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

/** A kind as it is registered: its name, the field set it fixes, and a label. */
export interface CredentialKindDefinition extends CredentialFieldSet {
  readonly id: CredentialKind;
  readonly label?: string;
}

export const credentialKindDefinitionSchema = z
  .object({
    id: credentialKindSchema,
    required: z.array(z.enum(credentialFieldNames)),
    optional: z.array(z.enum(credentialFieldNames)),
    label: z.string().optional(),
  })
  .strict()
  .refine(
    ({ required, optional }) =>
      !required.some((field) => optional.includes(field)),
    { message: 'A credential field cannot be both required and optional.' },
  );

/**
 * The kinds the platform itself defines. A kind fixes its field set: a required
 * field must be present, and every field it does not list must be absent.
 * `API_TOKEN` is authentication (a provider key or a token); `USERNAME_PASSWORD`
 * is authentication with a name.
 */
export const builtinCredentialKinds: readonly CredentialKindDefinition[] = [
  { id: 'API_TOKEN', required: ['secret'], optional: [] },
  { id: 'USERNAME_PASSWORD', required: ['username', 'secret'], optional: [] },
];

/** Whether these values satisfy the kind's required and forbidden fields. */
export const credentialFieldsSatisfied = (
  { required, optional }: CredentialFieldSet,
  values: CredentialValues,
): boolean => {
  const allowed = new Set<CredentialField>([...required, ...optional]);

  return (
    required.every((field) => values[field] !== undefined) &&
    credentialFieldNames.every(
      (field) => values[field] === undefined || allowed.has(field),
    )
  );
};

/** The readable statement of that rule, used by the API's rejection messages. */
export const credentialFieldsMessage = ({
  id,
  required,
  optional,
}: CredentialKindDefinition): string => {
  const carries =
    optional.length === 0
      ? 'and carries no other field'
      : `and may also carry ${optional.join(', ')}`;

  return `A ${id} credential requires ${required.join(', ')} ${carries}.`;
};

export const credentialRefSchema = z.object({ id: z.string() }).strict();

export type CredentialRef = z.output<typeof credentialRefSchema>;

export const secretSchema = z
  .object({
    id: z.string(),
    kind: credentialKindSchema,
    name: z.string(),
    username: z.string().optional(),
    email: z.string().optional(),
    secret: z.string().optional(),
  })
  .strict();

export type Secret = z.output<typeof secretSchema>;

/** The public view of a credential; it never carries the secret. */
export const credentialDescriptionSchema = z
  .object({
    id: z.string(),
    kind: credentialKindSchema,
    name: z.string(),
    username: z.string().optional(),
    email: z.string().optional(),
    hasSecret: z.boolean(),
  })
  .strict();

export type CredentialDescription = z.output<
  typeof credentialDescriptionSchema
>;

export const credentialCreateSchema = z
  .object({
    kind: credentialKindSchema,
    name: z.string(),
    username: z.string().optional(),
    email: z.string().optional(),
    secret: z.string().optional(),
  })
  .strict();

export type CredentialCreate = z.output<typeof credentialCreateSchema>;

/** Absent or `null` keeps a stored field; any string, `''` included, sets it. */
const clearing = z.union([z.string(), z.null()]).optional();

export const credentialUpdateSchema = z
  .object({
    kind: credentialKindSchema.optional(),
    name: z.string().optional(),
    username: clearing,
    email: clearing,
    secret: clearing,
  })
  .strict();

export type CredentialUpdate = z.output<typeof credentialUpdateSchema>;

export const credentialWriteSchema = credentialDescriptionSchema;

export type CredentialWrite = CredentialDescription;

export const credentialDeleteResultSchema = z.enum([
  'deleted',
  'missing',
  'referenced',
]);

export const resolveByKindOptionsSchema = z
  .object({
    /** IDs excluded before the one-match rule. */
    exclude: z.array(z.string()).optional(),
  })
  .strict();

export type ResolveByKindOptions = z.input<typeof resolveByKindOptionsSchema>;

/** An in-process, synchronous view of the provider's cache. Never crosses a bridge. */
export interface SecretsView {
  /** Decrypted credentials, in the provider's cache order. */
  list(): readonly Secret[];
  /** Every non-empty stored secret, then every added one, in that order. */
  redactions(): readonly string[];
  /** Redacts a secret the host wrote elsewhere, for as long as the host runs. */
  addRedaction(secret: string): void;
}

export const isSecretsView = (value: unknown): value is SecretsView =>
  typeof value === 'object' &&
  value !== null &&
  typeof (value as { list?: unknown }).list === 'function' &&
  typeof (value as { redactions?: unknown }).redactions === 'function' &&
  typeof (value as { addRedaction?: unknown }).addRedaction === 'function';

/** The credential IDs a holder references now; called under the write lock. */
export type ReferenceSource = () => Iterable<string>;

export interface Secrets {
  resolve(ref: CredentialRef, call?: CallArg): Promise<Secret>;
  list(call?: CallArg): Promise<readonly CredentialDescription[]>;
  /** The kinds the call's generation sees: the built-in ones and the registered ones. */
  kinds(call?: CallArg): Promise<readonly CredentialKindDefinition[]>;
  /**
   * Registers a kind for the calling bundle (1.2.0). Like `tools/v1.register`,
   * it is partitioned by generation: a kind another registration in the same
   * view holds throws `duplicate_credential_kind`, and disposing the returned
   * registration releases the name.
   */
  registerKind(
    definition: CredentialKindDefinition,
    call?: CallArg,
  ): Disposable;
  describe(
    ref: CredentialRef,
    call?: CallArg,
  ): Promise<CredentialDescription | undefined>;
  create(input: CredentialCreate, call?: CallArg): Promise<CredentialWrite>;
  update(
    ref: CredentialRef,
    input: CredentialUpdate,
    call?: CallArg,
  ): Promise<CredentialWrite>;
  /** `referenced` when a registered reference source names the credential. */
  delete(
    ref: CredentialRef,
    call?: CallArg,
  ): Promise<'deleted' | 'missing' | 'referenced'>;
  resolveByKind(
    kind: CredentialKind,
    options?: ResolveByKindOptions,
    call?: CallArg,
  ): Promise<Secret | undefined>;
  /** API mínima: the redaction list, as `view().redactions()` of this process. */
  redactions(call?: CallArg): Promise<readonly string[]>;
  /**
   * 1.1.0: the complete redaction list (as `redactions()`) on subscribe and
   * after every change: a credential create, update or delete, or an added
   * redaction. `create`, `update` and `delete` resolve only after every
   * listener received the list they produced.
   */
  watchRedactions(
    listener: StreamListener<string[]>,
    call?: CallArg,
  ): Disposable;
  /** API mínima, local: references that make `delete` answer `referenced`. */
  registerReferences(source: ReferenceSource): Disposable;
  /** API mínima, local. */
  view(): SecretsView;
}

export const SecretsV1 = ref<Secrets>('secrets/v1');

export const secretsMethods = {
  resolve: { input: credentialRefSchema, output: secretSchema },
  list: {
    input: noInput,
    output: z.array(credentialDescriptionSchema),
    expose: 'desktop',
  },
  kinds: {
    input: noInput,
    output: z.array(credentialKindDefinitionSchema),
  },
  registerKind: {
    input: credentialKindDefinitionSchema,
    output: disposableSchema,
  },
  describe: {
    input: credentialRefSchema,
    output: credentialDescriptionSchema.optional(),
  },
  create: {
    input: credentialCreateSchema,
    output: credentialWriteSchema,
    expose: 'desktop',
  },
  update: {
    input: z.tuple([credentialRefSchema, credentialUpdateSchema]),
    output: credentialWriteSchema,
    expose: 'desktop',
  },
  delete: {
    input: credentialRefSchema,
    output: credentialDeleteResultSchema,
    expose: 'desktop',
  },
  resolveByKind: {
    input: z.tuple([
      credentialKindSchema,
      resolveByKindOptionsSchema.optional(),
    ]),
    output: secretSchema.optional(),
  },
  redactions: { input: noInput, output: z.array(z.string()) },
  watchRedactions: {
    input: streamListener(z.array(z.string())),
    output: disposableSchema,
  },
  registerReferences: {
    input: functionSchema<ReferenceSource>(),
    output: disposableSchema,
  },
  view: {
    input: noInput,
    output: z.custom<SecretsView>(isSecretsView, {
      message: 'Expected a secrets view.',
    }),
  },
} as const satisfies MethodSpecs;

/** A stored secret in plaintext across the contract; encryption stays in the backend. */
export const storedSecretSchema = z
  .object({
    id: z.string(),
    kind: credentialKindSchema,
    name: z.string(),
    username: z.string().optional(),
    email: z.string().optional(),
    secret: z.string().optional(),
    createdAt: z.string().optional(),
    updatedAt: z.string().optional(),
  })
  .strict();

export type StoredSecret = z.output<typeof storedSecretSchema>;

/** The backend stores plaintext across the contract; the envelope is inside it. */
export interface SecretsBackend {
  get(id: string, call?: CallArg): Promise<StoredSecret | undefined>;
  /** Ordered by name as the backend stores it (PostgreSQL: `ORDER BY name`). */
  list(call?: CallArg): Promise<readonly StoredSecret[]>;
  /** Upsert by ID. An update never changes `kind` (the facade refuses it first). */
  put(record: StoredSecret, call?: CallArg): Promise<void>;
  delete(id: string, call?: CallArg): Promise<'deleted' | 'missing'>;
}

export const SecretsBackendV1 = ref<SecretsBackend>('secrets.backend/v1');

export const secretsBackendMethods = {
  get: { input: z.string(), output: storedSecretSchema.optional() },
  list: { input: noInput, output: z.array(storedSecretSchema) },
  put: { input: storedSecretSchema, output: z.void() },
  delete: { input: z.string(), output: z.enum(['deleted', 'missing']) },
} as const satisfies MethodSpecs;
