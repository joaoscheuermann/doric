import {
  type ProviderField,
  type ProviderKindId,
  providerKind,
  reasoningEfforts,
} from 'llms';
import { z } from 'zod';

const effort = z.enum(reasoningEfforts);
const identifier = z.string().trim().min(1).max(128);
const model = z.string().trim().min(1).max(512);
const limit = z.number().int().safe().positive();

/**
 * A kind the catalog knows. The check is what makes the type say what it proved,
 * so the rules below read a kind's fields without narrowing the value again.
 */
const providerKindId = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .transform((value, context) => {
    const kind = providerKind(value);

    if (kind === undefined) {
      context.addIssue({
        code: 'custom',
        message: `Unknown provider kind: ${value}`,
      });
      return z.NEVER;
    }

    return kind.id;
  });

/**
 * A kind's own list: no entry twice, and no empty entry. A kind that keeps a list
 * may still hold none, because a provider whose models have not been named yet is
 * still selectable, with its model typed by hand.
 */
const uniqueList = <Schema extends z.ZodType>(entry: Schema) =>
  z.array(entry).refine((values) => new Set(values).size === values.length, {
    message: 'A provider list cannot repeat an entry.',
  });

/**
 * One model a provider lists. Its name is the model id an execution profile
 * types. When the kind keeps `reasonings`, the model carries its own efforts; a
 * kind that keeps models without reasonings carries a name alone.
 */
interface ProviderModelInput {
  readonly name: string;
  readonly reasonings?: readonly string[];
  /**
   * The effort this model's own catalog names as its default, which the host
   * writes from that catalog rather than an operator naming it.
   */
  readonly defaultEffort?: string;
  /**
   * Whether the model's catalog pins reasoning on, so no request may turn it off.
   * Like `defaultEffort`, the host reads it from the catalog.
   */
  readonly mandatory?: boolean;
}

/**
 * The kind and values one provider carries, with its id when the caller has one:
 * a stored configuration always names a provider, while a provider page asking a
 * catalog what it lists holds a draft that may not be named yet.
 */
export interface ProviderValuesRef {
  readonly id?: string;
  readonly kind: ProviderKindId;
  readonly configuration: Readonly<Record<string, string>>;
  readonly models?: readonly ProviderModelInput[];
}

/** One provider's values, judged against the kind it names. */
interface ProviderValuesInput {
  readonly kind: ProviderKindId;
  readonly configuration: Readonly<Record<string, string>>;
  readonly models?: readonly ProviderModelInput[];
}

/** The fields a kind declares that carry a credential, whose value is its id. */
const secretFields = (kindId: ProviderKindId): readonly ProviderField[] =>
  providerKind(kindId)?.fields.filter((field) => field.kind === 'secret') ?? [];

/**
 * Whether one declared value is one the field's kind accepts. A `secret` value is
 * the id of a stored credential, which the service checks against the credential
 * store: this reads the reference, it does not resolve it.
 */
const fieldIssue = (
  field: ProviderField,
  value: string,
): string | undefined => {
  switch (field.kind) {
    case 'url':
      return value.startsWith('http://') || value.startsWith('https://')
        ? undefined
        : `${field.key} must use HTTP or HTTPS.`;
    case 'number':
      return Number.isFinite(Number(value))
        ? undefined
        : `${field.key} must be a number.`;
    case 'enum':
      return field.options?.includes(value) === true
        ? undefined
        : `${field.key} must be one of ${field.options?.join(', ')}.`;
    case 'secret':
      return z.uuid().safeParse(value).success
        ? undefined
        : `${field.key} must name a stored credential.`;
    case 'text':
      return undefined;
  }
};

/**
 * The fields a kind declares are the fields a provider carries: every required
 * value present and non-empty, no unknown key, and an optional value either
 * absent or set, never empty. The kind also decides which lists the row keeps.
 * The catalog owns the field sets, so this restates none of them.
 */
const providerFieldsRule = (
  value: Pick<ProviderValuesInput, 'kind' | 'configuration'>,
  context: z.RefinementCtx,
): void => {
  const kind = providerKind(value.kind);

  // A kind's own check refused any other kind, so this one is a known one.
  if (kind === undefined) return;

  const declared = new Map(kind.fields.map((field) => [field.key, field]));

  for (const [key, entry] of Object.entries(value.configuration)) {
    const field = declared.get(key);
    let issue: string | undefined;

    if (field === undefined) {
      issue = `Provider kind ${kind.id} declares no ${key} value.`;
    } else if (entry.trim() === '') {
      issue = field.required
        ? `Provider kind ${kind.id} requires ${key}.`
        : `An unset ${key} is absent, not empty.`;
    } else {
      issue = fieldIssue(field, entry);
    }

    if (issue !== undefined)
      context.addIssue({
        code: 'custom',
        message: issue,
        path: ['configuration', key],
      });
  }

  for (const field of kind.fields)
    if (field.required && value.configuration[field.key] === undefined)
      context.addIssue({
        code: 'custom',
        message: `Provider kind ${kind.id} requires ${field.key}.`,
        path: ['configuration', field.key],
      });
};

/**
 * One provider's values without its lists, for a caller that holds none: asking a
 * kind's model catalog what it lists happens on the provider page, before any of
 * that provider's models exist. It applies the same field rule a stored provider
 * obeys, so a value the configuration would refuse never reaches an endpoint.
 */
export const ProviderValuesSchema = z
  .object({
    kind: providerKindId,
    configuration: z.record(z.string(), z.string()),
  })
  .strict()
  .superRefine(providerFieldsRule);

const providerKindRules = (
  value: ProviderValuesInput,
  context: z.RefinementCtx,
): void => {
  providerFieldsRule(value, context);

  const kind = providerKind(value.kind);

  // A kind's own check refused any other kind, so this one is a known one.
  if (kind === undefined) return;
  const keepsModels = kind.lists.includes('models');
  const keepsReasonings = kind.lists.includes('reasonings');

  if (keepsModels !== (value.models !== undefined)) {
    context.addIssue({
      code: 'custom',
      message: keepsModels
        ? `Provider kind ${kind.id} keeps models.`
        : `Provider kind ${kind.id} does not keep models.`,
      path: ['models'],
    });
    return;
  }

  if (value.models === undefined) return;

  const names = new Set<string>();
  value.models.forEach((entry, index) => {
    const trimmed = entry.name.trim();

    if (names.has(trimmed))
      context.addIssue({
        code: 'custom',
        message: 'A provider cannot list a model twice.',
        path: ['models', index, 'name'],
      });

    names.add(trimmed);

    if (keepsReasonings !== (entry.reasonings !== undefined)) {
      context.addIssue({
        code: 'custom',
        message: keepsReasonings
          ? `Provider kind ${kind.id} keeps a model's reasonings.`
          : `Provider kind ${kind.id} does not keep a model's reasonings.`,
        path: ['models', index, 'reasonings'],
      });
      return;
    }

    // Both are the catalog's to say, so a model of a kind that keeps no
    // reasonings has no reasoning block for them to describe.
    if (!keepsReasonings) {
      if (entry.defaultEffort !== undefined || entry.mandatory !== undefined) {
        context.addIssue({
          code: 'custom',
          message: `Provider kind ${kind.id} does not keep a model's reasoning.`,
          path: ['models', index],
        });
      }
      return;
    }

    if (
      entry.defaultEffort !== undefined &&
      !entry.reasonings?.includes(entry.defaultEffort)
    ) {
      context.addIssue({
        code: 'custom',
        message: `Model ${entry.name} defaults to an effort it does not list.`,
        path: ['models', index, 'defaultEffort'],
      });
    }
  });
};

/**
 * One model a provider lists. A kind that keeps `reasonings` validates each
 * model's own efforts here; the kind's rules decide whether it may carry them.
 */
const providerModel = z
  .object({
    name: model,
    reasonings: uniqueList(effort).optional(),
    defaultEffort: effort.optional(),
    mandatory: z.boolean().optional(),
  })
  .strict();

/**
 * One configured provider: the kind it names, exactly that kind's values, and the
 * models the kind keeps.
 */
const provider = z
  .object({
    id: identifier,
    kind: providerKindId,
    configuration: z.record(z.string(), z.string()),
    models: z.array(providerModel).optional(),
  })
  .strict()
  .superRefine(providerKindRules);

const reasoningModel = z
  .object({
    providerId: identifier,
    model,
    /**
     * The effort the model accepts. Absent when the model lists none: a model a
     * catalog describes without efforts cannot be told one, so no reasoning block
     * is sent for it.
     */
    effort: effort.optional(),
  })
  .strict();

const providers = z.array(provider).min(1);

const models = z.object({ execution: reasoningModel }).strict();

const execution = z
  .object({ maxTurns: limit, maxToolResultChars: limit.optional() })
  .strict();

interface ProviderReferences {
  readonly providers: readonly { readonly id: string }[];
  readonly models: { readonly execution: { readonly providerId: string } };
}

/** Provider IDs stay unique and every model profile references a known one. */
const referencesKnownProviders = (
  value: ProviderReferences,
  context: z.RefinementCtx,
): void => {
  const ids = new Set<string>();

  value.providers.forEach(({ id }, index) => {
    if (ids.has(id)) {
      context.addIssue({
        code: 'custom',
        message: 'Provider IDs must be unique.',
        path: ['providers', index, 'id'],
      });
    }

    ids.add(id);
  });

  if (!ids.has(value.models.execution.providerId)) {
    context.addIssue({
      code: 'custom',
      message: 'Model references an unavailable provider.',
      path: ['models', 'execution', 'providerId'],
    });
  }
};

/**
 * Complete configuration exactly as the host persists it.
 *
 * A provider names a kind and that kind's own values; each `secret` value names a
 * stored credential, and so do the two GitHub-related integrations, while the
 * stored configuration holds no secret of its own. `GET /config` therefore
 * answers the same shape `PUT /config` accepts. An absent choice is the
 * unconfigured form, and the service refuses a reference that names a missing
 * credential or the wrong kind before it is activated.
 */
/**
 * Per-tool configuration values, keyed by tool name and then by the tool's own
 * field keys. It is an open record on purpose: bundles load at runtime, so the
 * fields a tool declares are validated against the loaded catalog at binding
 * time rather than by this static schema. A `secret` value names a stored
 * credential, exactly as a provider's secret field does.
 */
const tools = z.record(z.string(), z.record(z.string(), z.string())).optional();

export const ConfigInputSchema = z
  .object({
    providers,
    models,
    execution,
    tools,
    gitCredentialId: z.uuid().optional(),
    githubCredentialId: z.uuid().optional(),
  })
  .strict()
  .superRefine(referencesKnownProviders);

export type ConfigInput = z.output<typeof ConfigInputSchema>;

/** Per-tool values as stored: a keyed string map per tool, or none yet. */
export type ToolConfigInput = NonNullable<ConfigInput['tools']>;

export interface DoricConfig {
  readonly configuration: ConfigInput;
  readonly revision: number;
  readonly updatedAt: string;
}

/**
 * Every credential one configured provider names, with the field that named it.
 * A `secret` field the provider left unset names none. It reads only the kind and
 * the values, so a caller holding a draft — a provider page asking a catalog what
 * it lists — asks the same question the configuration does.
 */
export const providerCredentials = (
  provider: ProviderValuesRef,
): readonly {
  readonly field: ProviderField;
  readonly id: string;
}[] =>
  secretFields(provider.kind).flatMap((field) => {
    const id = provider.configuration[field.key];

    return id === undefined ? [] : [{ field, id }];
  });

/**
 * The credential the baseline migration seeds for the seeded provider, so the
 * stored configuration and this default agree.
 */
const baselineCredentialId = '00000000-0000-4000-8000-000000000002';

/**
 * The configuration a host starts with. It is the baseline migration's own
 * OpenRouter provider after catalog consolidation, with an empty model list
 * until an operator names the models it may use.
 */
export const defaultConfig: ConfigInput = {
  providers: [
    {
      id: 'openrouter',
      kind: 'openrouter',
      configuration: {
        endpoint: 'https://openrouter.ai/api/v1',
        token: baselineCredentialId,
      },
      models: [],
    },
  ],
  models: {
    execution: {
      providerId: 'openrouter',
      model: 'deepseek/deepseek-v4-flash-0731',
      effort: 'low',
    },
  },
  execution: { maxTurns: 32 },
  tools: {},
};
