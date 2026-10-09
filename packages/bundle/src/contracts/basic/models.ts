import { z } from 'zod';

import type { CallArg } from '../call.js';
import { ref } from '../define.js';
import { type MethodSpecs, noInput } from './common.js';

// Structural mirrors of `packages/llms` provider kinds (`ProviderKind`,
// `ProviderField`); bundle/contracts cannot depend on llms. First provider in
// stage 6; shapes may be refined before a provider publishes.

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

export const modelEntrySchema = z.looseObject({
  id: z.string(),
  reasonings: z.array(z.string()).optional(),
});

export type ModelEntry = z.output<typeof modelEntrySchema>;

declare const languageModelBrand: unique symbol;

/** Opaque, process-local model handle; stage 6 narrows it to the llms provider. */
export interface LanguageModel {
  readonly [languageModelBrand]?: true;
}

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

export interface Models {
  resolve(model: ModelRequest, call?: CallArg): Promise<ResolvedModel>;
}

export const ModelsV1 = ref<Models>('models/v1');

const modelRequestSchema = z
  .object({
    providerId: z.string(),
    model: z.string(),
    effort: z.string().optional(),
  })
  .strict();

const languageModelSchema = z.custom<LanguageModel>(
  (value) => typeof value === 'object' && value !== null,
);

export const modelsMethods = {
  resolve: {
    input: modelRequestSchema,
    output: z.custom<ResolvedModel>(
      (value) =>
        typeof value === 'object' &&
        value !== null &&
        languageModelSchema.safeParse(
          (value as { languageModel?: unknown }).languageModel,
        ).success,
    ),
  },
} as const satisfies MethodSpecs;

export type ModelProviderConfig = Readonly<Record<string, unknown>>;

export interface ModelsProvider {
  kind(call?: CallArg): ModelKindDescriptor;
  listModels(
    config: ModelProviderConfig,
    call?: CallArg,
  ): Promise<readonly ModelEntry[]>;
  create(
    config: ModelProviderConfig,
    secrets: Readonly<Record<string, string>>,
    call?: CallArg,
  ): LanguageModel;
}

export const ModelsProviderV1 = ref<ModelsProvider>('models.provider/v1');

export const modelsProviderMethods = {
  kind: { input: noInput, output: modelKindDescriptorSchema },
  listModels: {
    input: z.record(z.string(), z.unknown()),
    output: z.array(modelEntrySchema),
  },
  create: {
    input: z.tuple([
      z.record(z.string(), z.unknown()),
      z.record(z.string(), z.string()),
    ]),
    output: languageModelSchema,
  },
} as const satisfies MethodSpecs;
