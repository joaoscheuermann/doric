import { z } from 'zod';

import type { CallArg } from '../call.js';
import { ref } from '../define.js';
import { type MethodSpecs, noInput } from './common.js';

/** Mirrors the host's credential kinds (`agents/doric` credentials). */
export const credentialKindSchema = z.enum([
  'API_TOKEN',
  'USERNAME_PASSWORD',
  'GIT',
]);

export type CredentialKind = z.output<typeof credentialKindSchema>;

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

/** Absent keeps a field, `''` clears it, a value sets it. */
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

/** First provider in stage 2; shapes may be refined before a provider publishes. */
export interface Secrets {
  resolve(ref: CredentialRef, call?: CallArg): Promise<Secret>;
  list(call?: CallArg): Promise<readonly CredentialDescription[]>;
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
  delete(
    ref: CredentialRef,
    call?: CallArg,
  ): Promise<'deleted' | 'missing' | 'referenced'>;
  resolveByKind(
    kind: CredentialKind,
    call?: CallArg,
  ): Promise<Secret | undefined>;
}

export const SecretsV1 = ref<Secrets>('secrets/v1');

export const secretsMethods = {
  resolve: { input: credentialRefSchema, output: secretSchema },
  list: { input: noInput, output: z.array(credentialDescriptionSchema) },
  describe: {
    input: credentialRefSchema,
    output: credentialDescriptionSchema.optional(),
  },
  create: { input: credentialCreateSchema, output: credentialWriteSchema },
  update: {
    input: z.tuple([credentialRefSchema, credentialUpdateSchema]),
    output: credentialWriteSchema,
  },
  delete: { input: credentialRefSchema, output: credentialDeleteResultSchema },
  resolveByKind: {
    input: credentialKindSchema,
    output: secretSchema.optional(),
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

export interface SecretsBackend {
  get(id: string, call?: CallArg): Promise<StoredSecret | undefined>;
  list(call?: CallArg): Promise<readonly StoredSecret[]>;
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
