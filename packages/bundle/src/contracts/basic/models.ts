import { z } from 'zod';

import type { CallArg } from '../call.js';
import { ref } from '../define.js';
import { functionSchema, type MethodSpecs, noInput } from './common.js';

// Structural mirrors of `packages/llms` provider kinds (`ProviderKind`,
// `ProviderField`, `CatalogModel`); bundle/contracts cannot depend on llms.
// Refined for stage 6, the first provider (design 57 §2.10).

/** The key of the codec marker in generated schemas (`runtime/json-schema`). */
const LOCAL_KEY = 'x-doric-local';

export const modelFieldSchema = z
  .object({
    key: z.string(),
    label: z.string(),
    kind: z.enum(['text', 'url', 'number', 'enum', 'secret']),
    required: z.boolean(),
    description: z.string().optional(),
    placeholder: z.string().optional(),
    options: z.array(z.string()).optional(),
    advanced: z.boolean().optional(),
  })
  .strict();

export type ModelField = z.output<typeof modelFieldSchema>;

/** The llms `ProviderKind` object, unchanged. */
export const modelKindDescriptorSchema = z
  .object({
    id: z.string(),
    label: z.string(),
    description: z.string(),
    fields: z.array(modelFieldSchema),
    lists: z.array(z.enum(['models', 'reasonings'])),
  })
  .strict();

export type ModelKindDescriptor = z.output<typeof modelKindDescriptorSchema>;

/** One model of a kind's catalog, as llms `CatalogModel` reads it. */
export const catalogModelSchema = z.looseObject({
  id: z.string(),
  name: z.string().optional(),
  reasonings: z.array(z.string()),
  parameters: z.array(z.string()),
  defaultEffort: z.string().optional(),
  mandatory: z.boolean(),
});

export type CatalogModel = z.output<typeof catalogModelSchema>;

/** A catalog read: the models, or why there are none (no URL, or a failed read). */
export const catalogResultSchema = z.union([
  z
    .object({ status: z.literal('read'), models: z.array(catalogModelSchema) })
    .strict(),
  z.object({ status: z.enum(['absent', 'failed']) }).strict(),
]);

export type CatalogResult = z.output<typeof catalogResultSchema>;

declare const languageModelBrand: unique symbol;

/**
 * Opaque, process-local model handle (the llms provider). It crosses the
 * envelope as an `object` handle: back in the process that built it, it is
 * the original object; anywhere else any use is `local_only`.
 */
export interface LanguageModel {
  readonly [languageModelBrand]?: true;
}

class LanguageModelObject {}

/**
 * Marks a provider object as a language model handle. A plain object would
 * cross the envelope by copy, so the result has its own prototype and the
 * same own properties (getters stay getters), and is what `create` returns.
 * An object that already has a non-plain prototype is returned unchanged.
 */
export const toLanguageModel = <T extends object>(
  value: T,
): T & LanguageModel => {
  const prototype = Object.getPrototypeOf(value) as unknown;

  if (prototype !== Object.prototype && prototype !== null) {
    return value as T & LanguageModel;
  }

  return Object.create(
    LanguageModelObject.prototype,
    Object.getOwnPropertyDescriptors(value),
  ) as T & LanguageModel;
};

export const languageModelSchema = z
  .custom<LanguageModel>(
    (value) => typeof value === 'object' && value !== null,
    { message: 'Expected a language model.' },
  )
  .meta({ [LOCAL_KEY]: 'object' });

export interface ResolvedModel {
  readonly providerId: string;
  readonly model: string;
  readonly effort?: string;
  readonly languageModel: LanguageModel;
}

export interface ModelRequest {
  readonly providerId: string;
  readonly model: string;
  readonly effort?: string;
}

export type ModelsConfiguration = Readonly<Record<string, unknown>>;

export interface Models {
  /**
   * The cached provider of the current configuration revision; throws
   * 'Configured provider is unavailable.' otherwise. The language model
   * crosses as an `object` handle, so it is usable in the process that built it.
   */
  resolve(model: ModelRequest, call?: CallArg): Promise<ResolvedModel>;
  /** Advertised kinds in registration order (llms `providerKinds`). */
  kinds(call?: CallArg): Promise<readonly ModelKindDescriptor[]>;
  /** Any registered kind, internal ones included (codex), for validation and building. */
  kind(id: string, call?: CallArg): Promise<ModelKindDescriptor | undefined>;
  /** Resolves the draft's secret field through secrets/v1, then reads the kind's catalog. */
  catalog(
    input: {
      readonly kind: string;
      readonly configuration: Readonly<Record<string, string>>;
    },
    call?: CallArg,
  ): Promise<CatalogResult>;
  /** Builds and caches every provider of a configuration; throws when one cannot be built. */
  prepare(configuration: ModelsConfiguration, call?: CallArg): Promise<void>;
  /**
   * 1.1.0: a model's context capacity from its provider's live catalog. The
   * candidates are the configured providers whose kind reports
   * `catalogCapacity()` and that are `providerId`, or, without one, list
   * `model`. With exactly one candidate, its cached provider (the one
   * `resolve` answers) reads `models()`. Answers a finite capacity above 0,
   * else `undefined`; it never throws.
   */
  contextWindow(
    request: { readonly providerId?: string; readonly model: string },
    call?: CallArg,
  ): Promise<number | undefined>;
}

export const ModelsV1 = ref<Models>('models/v1');

const modelRequestSchema = z
  .object({
    providerId: z.string(),
    model: z.string(),
    effort: z.string().optional(),
  })
  .strict();

const resolvedModelSchema = z
  .object({
    providerId: z.string(),
    model: z.string(),
    effort: z.string().optional(),
    languageModel: languageModelSchema,
  })
  .strict();

const configurationValuesSchema = z.record(z.string(), z.string());

export const modelsMethods = {
  resolve: { input: modelRequestSchema, output: resolvedModelSchema },
  kinds: {
    input: noInput,
    output: z.array(modelKindDescriptorSchema),
    expose: 'desktop',
  },
  kind: {
    input: z.tuple([z.string()]),
    output: modelKindDescriptorSchema.optional(),
    expose: 'desktop',
  },
  catalog: {
    input: z
      .object({ kind: z.string(), configuration: configurationValuesSchema })
      .strict(),
    output: catalogResultSchema,
    expose: 'desktop',
  },
  prepare: {
    input: z.record(z.string(), z.unknown()),
    output: z.void(),
  },
  contextWindow: {
    input: z
      .object({ providerId: z.string().optional(), model: z.string() })
      .strict(),
    output: z.number().optional(),
  },
} as const satisfies MethodSpecs;

/** What `create` receives: the provider's values and, when it has one, its secret. */
export interface ModelsProviderCreateInput {
  readonly providerId: string;
  readonly values: Readonly<Record<string, string>>;
  /**
   * Reads the provider's secret as stored now. The provider awaits it before
   * each request, so a rotated credential reaches the next request.
   */
  readonly secret?: () => Promise<string>;
}

export interface ModelsProvider {
  /** The llms ProviderKind object, unchanged. */
  kind(call?: CallArg): Promise<ModelKindDescriptor>;
  /** Whether GET /providers/kinds lists it (codex: false). */
  advertised(call?: CallArg): Promise<boolean>;
  /** The models URL catalog read (POST /providers/models and the PUT /config fill). */
  catalog(
    input: {
      readonly configuration: Readonly<Record<string, string>>;
      readonly secret?: string;
    },
    call?: CallArg,
  ): Promise<CatalogResult>;
  /** Builds the provider; the result is a handle made with `toLanguageModel`. */
  create(
    input: ModelsProviderCreateInput,
    call?: CallArg,
  ): LanguageModel | Promise<LanguageModel>;
  /**
   * 1.1.0: whether the built provider's `models()` reports context capacity
   * (`models/v1.contextWindow`). A provider that fails to answer has none.
   */
  catalogCapacity(call?: CallArg): Promise<boolean>;
}

export const ModelsProviderV1 = ref<ModelsProvider>('models.provider/v1');

export const modelsProviderMethods = {
  kind: { input: noInput, output: modelKindDescriptorSchema },
  advertised: { input: noInput, output: z.boolean() },
  catalog: {
    input: z
      .object({
        configuration: configurationValuesSchema,
        secret: z.string().optional(),
      })
      .strict(),
    output: catalogResultSchema,
  },
  create: {
    input: z
      .object({
        providerId: z.string(),
        values: configurationValuesSchema,
        secret: functionSchema<() => Promise<string>>()
          .meta({ [LOCAL_KEY]: 'callback' })
          .optional(),
      })
      .strict(),
    output: languageModelSchema,
  },
  catalogCapacity: { input: noInput, output: z.boolean() },
} as const satisfies MethodSpecs;
