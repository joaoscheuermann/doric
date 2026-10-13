import { type CallArg, ref } from 'bundle/contracts';
import { z } from 'zod';

/*
 * host-config/v1: the Doric configuration (design 57 §2.9 as revised, X-6).
 * This bundle owns the ref and provides it. The value types are structural
 * mirrors of the bundle's `ConfigInput` and `DoricConfig`: the real schema needs
 * the llms kind catalog, so the provider validates and this contract carries
 * the value unchanged.
 */

export interface ConfigurationModel {
  readonly name: string;
  readonly reasonings?: readonly string[];
  readonly defaultEffort?: string;
  readonly mandatory?: boolean;
}

export interface ConfigurationProvider {
  readonly id: string;
  readonly kind: string;
  /** The kind's own values; a `secret` field's value is a credential id. */
  readonly configuration: Readonly<Record<string, string>>;
  readonly models?: readonly ConfigurationModel[];
}

/**
 * The context-compaction policy one execution carries. The field is optional and
 * this contract carries it unchanged: the consumer applies the defaults an
 * absent policy stands for — `enabled: true`, `pressurePercent: 80`,
 * `tailMinMessages: 6`, `summaryMaxChars: 6000`, `charBudget: 200000`.
 */
export interface ContextCompactionConfig {
  readonly enabled: boolean;
  readonly pressurePercent: number;
  readonly tailMinMessages: number;
  readonly summaryMaxChars: number;
  readonly charBudget: number;
}

export interface ConfigurationValue {
  readonly providers: readonly ConfigurationProvider[];
  readonly models: {
    readonly execution: {
      readonly providerId: string;
      readonly model: string;
      readonly effort?: string;
    };
  };
  readonly execution: {
    readonly maxTurns: number;
    readonly maxToolResultChars?: number;
    readonly contextCompaction?: ContextCompactionConfig;
  };
  readonly tools?: Readonly<Record<string, Readonly<Record<string, string>>>>;
  readonly gitCredentialId?: string;
  readonly githubCredentialId?: string;
}

/** The exact GET /config body. */
export interface DoricConfiguration {
  readonly configuration: ConfigurationValue;
  readonly revision: number;
  readonly updatedAt: string;
}

export type ConfigReplaceResult =
  | { readonly status: 'replaced'; readonly config: DoricConfiguration }
  /** Invalid input, an unusable credential or a tool value → 422 invalid_config. */
  | { readonly status: 'invalid'; readonly message: string }
  /** Anything else → 503 configuration_rejected. */
  | { readonly status: 'rejected' };

export interface Configuration {
  /** The active configuration, revision and update time. */
  current(call?: CallArg): Promise<DoricConfiguration>;
  /**
   * The PUT /config pipeline, serialized. The input is the request body as
   * received: a body the configuration schema refuses answers
   * `{ status: 'invalid', message: 'The Doric configuration is invalid.' }`.
   */
  replace(input: unknown, call?: CallArg): Promise<ConfigReplaceResult>;
}

const configurationModelSchema = z.looseObject({
  name: z.string(),
  reasonings: z.array(z.string()).optional(),
  defaultEffort: z.string().optional(),
  mandatory: z.boolean().optional(),
});

export const configurationValueSchema: z.ZodType<
  ConfigurationValue,
  ConfigurationValue
> = z.looseObject({
  providers: z.array(
    z.looseObject({
      id: z.string(),
      kind: z.string(),
      configuration: z.record(z.string(), z.string()),
      models: z.array(configurationModelSchema).optional(),
    }),
  ),
  models: z.looseObject({
    execution: z.looseObject({
      providerId: z.string(),
      model: z.string(),
      effort: z.string().optional(),
    }),
  }),
  execution: z.looseObject({
    maxTurns: z.number(),
    maxToolResultChars: z.number().optional(),
    contextCompaction: z
      .looseObject({
        enabled: z.boolean(),
        pressurePercent: z.number(),
        tailMinMessages: z.number(),
        summaryMaxChars: z.number(),
        charBudget: z.number(),
      })
      .optional(),
  }),
  tools: z.record(z.string(), z.record(z.string(), z.string())).optional(),
  gitCredentialId: z.string().optional(),
  githubCredentialId: z.string().optional(),
});

export const doricConfigurationSchema: z.ZodType<
  DoricConfiguration,
  DoricConfiguration
> = z.looseObject({
  configuration: configurationValueSchema,
  revision: z.number(),
  updatedAt: z.string(),
});

export const configReplaceResultSchema: z.ZodType<
  ConfigReplaceResult,
  ConfigReplaceResult
> = z.union([
  z.looseObject({
    status: z.literal('replaced'),
    config: doricConfigurationSchema,
  }),
  z.looseObject({ status: z.literal('invalid'), message: z.string() }),
  z.looseObject({ status: z.literal('rejected') }),
]);

export const configurationMethods = {
  current: {
    input: z.tuple([]),
    output: doricConfigurationSchema,
    expose: 'desktop',
  },
  replace: {
    input: z.unknown(),
    output: configReplaceResultSchema,
    expose: 'desktop',
  },
} as const;

export const ConfigurationV1 = ref<Configuration>('host-config/v1');
