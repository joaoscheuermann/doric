import type { Logger } from 'pino';

import type { HttpTransport } from '../types/http.js';
import type { LlmProvider } from '../types/provider.js';
import { codexMetadata, createCodexProvider } from './codex.js';
import {
  createOpenAiProvider,
  openAiMetadata,
  type SecretSource,
} from './openai.js';
import {
  createOpenRouterProvider,
  defaultStructuredOutputRepairs,
  openRouterMetadata,
} from './openrouter.js';

/** Every provider integration this package can configure. */
export type ProviderKindId = 'openai' | 'openrouter' | 'codex';

export type ProviderFieldKind = 'text' | 'url' | 'number' | 'enum' | 'secret';

export interface ProviderField {
  readonly key: string;
  readonly label: string;
  readonly kind: ProviderFieldKind;
  readonly required: boolean;
  readonly description?: string;
  readonly placeholder?: string;
  /** The values an `enum` field offers; present only for `kind: 'enum'`. */
  readonly options?: readonly string[];
  /**
   * Whether the field is one an operator rarely needs, so a settings surface can
   * keep it out of the way and show the necessary fields alone.
   */
  readonly advanced?: boolean;
}

/**
 * The per-provider lists a kind keeps: edited as tables, read by other sections.
 * `models` is the provider's own model list; `reasonings` is carried per model,
 * so a kind that keeps it has every model in that list name its own efforts. No
 * kind keeps `reasonings` without `models`.
 */
export type ProviderListId = 'models' | 'reasonings';

export interface ProviderKind {
  readonly id: ProviderKindId;
  readonly label: string;
  readonly description: string;
  /** The values a provider of this kind needs. */
  readonly fields: readonly ProviderField[];
  /** Which per-provider lists this kind keeps. */
  readonly lists: readonly ProviderListId[];
}

/**
 * A base URL. Absent means the factory's own endpoint, which is why the default
 * travels as the placeholder a settings surface shows instead of as a value. It is
 * an advanced field: a kind's own endpoint is the right one until an operator
 * points the provider somewhere else.
 */
const endpoint = (defaultBaseUrl: string): ProviderField => ({
  key: 'endpoint',
  label: 'Endpoint',
  kind: 'url',
  required: false,
  advanced: true,
  description: 'Overrides the base URL requests are sent to.',
  placeholder: defaultBaseUrl,
});

/**
 * The URL a kind's model catalog lives at, where the catalog also says what each
 * model accepts. Absent means the kind's own catalog URL, which travels as the
 * placeholder exactly as `endpoint`'s default does. Only a kind whose catalog
 * describes its models keeps this field: a kind whose catalog lists ids alone
 * keeps the efforts on the models an operator names.
 */
const modelsUrl = (defaultModelsUrl: string): ProviderField => ({
  key: 'modelsUrl',
  label: 'Models URL',
  kind: 'url',
  required: false,
  advanced: true,
  description:
    'Where this provider lists the models it serves and what each one accepts.',
  placeholder: defaultModelsUrl,
});

/**
 * The stored credential a kind authenticates with. The value is the id of a
 * stored `API_TOKEN` credential; llms never reads that store, so the meaning
 * lives in this text and resolving the id stays the host's job.
 */
const token = (options: {
  readonly required: boolean;
  readonly description: string;
}): ProviderField => ({
  key: 'token',
  label: 'Token',
  kind: 'secret',
  required: options.required,
  description: options.description,
});

/** Responses and OpenRouter providers keep models and their reasoning efforts. */
const openAiLists: readonly ProviderListId[] = ['models', 'reasonings'];

/** Supported integrations, including Codex retained for existing internal callers. */
const supportedKinds: readonly ProviderKind[] = [
  {
    id: 'openai',
    label: 'OpenAI',
    description:
      'Any endpoint that answers the OpenAI Responses API, under its own identity.',
    fields: [
      endpoint(openAiMetadata.baseUrl),
      token({
        required: false,
        description:
          'Names the stored API_TOKEN credential to authenticate with. Absent leaves the auth header off, which a compatible endpoint may accept.',
      }),
    ],
    lists: openAiLists,
  },
  {
    id: 'openrouter',
    label: 'OpenRouter',
    description:
      'OpenRouter Chat Completions with curated model profiles, live capability discovery, and structured-output repair.',
    fields: [
      endpoint(openRouterMetadata.baseUrl),
      token({
        required: true,
        description:
          'Names the stored API_TOKEN credential this provider authenticates with.',
      }),
      {
        key: 'maxStructuredOutputRepairs',
        label: 'Structured output repairs',
        kind: 'number',
        required: false,
        advanced: true,
        description:
          'How many corrected attempts a rejected structured response gets.',
        placeholder: String(defaultStructuredOutputRepairs),
      },
      modelsUrl(`${openRouterMetadata.baseUrl}/models`),
    ],
    lists: openAiLists,
  },
  {
    id: 'codex',
    label: 'Codex',
    description:
      'The ChatGPT Codex Responses backend, authenticated with a Codex authorization value.',
    fields: [
      endpoint(codexMetadata.baseUrl),
      token({
        required: true,
        description:
          'Names the stored API_TOKEN credential that carries the Codex authorization value.',
      }),
      {
        key: 'chatGptAccountId',
        label: 'ChatGPT account ID',
        kind: 'text',
        required: false,
        description:
          'The account id sent as ChatGPT-Account-ID beside the authorization value.',
      },
      {
        key: 'fedramp',
        label: 'FedRAMP',
        kind: 'enum',
        required: false,
        description: 'Sends X-OpenAI-Fedramp for a FedRAMP ChatGPT account.',
        placeholder: 'false',
        options: ['true', 'false'],
      },
    ],
    lists: [],
  },
];

/** The integrations advertised to users. Codex remains internal for now. */
export const providerKinds: readonly ProviderKind[] = supportedKinds.filter(
  ({ id }) => id !== 'codex',
);

/**
 * The kind a configured provider names. A string that names none is not a kind,
 * so a caller decides how to reject it rather than receiving a guess.
 */
export const providerKind = (id: string): ProviderKind | undefined =>
  supportedKinds.find((kind) => kind.id === id);

/**
 * The configuration one provider carries: a value per declared field. A `secret`
 * field's value names a stored credential, and a caller may pass that name or a
 * source it reads at call time, so a rotated credential still reaches a provider
 * that was built before the rotation.
 */
export type ProviderValues = Readonly<Record<string, SecretSource>>;

export interface ProviderKindDeps {
  readonly transport: HttpTransport;
  readonly logger: Logger;
  /**
   * The identity a compatible factory reports as its own. A configured provider
   * is known by its own id, so this is that id rather than a value an operator
   * types into the kind's fields.
   */
  readonly identity: {
    readonly id: string;
    readonly name: string;
  };
}

/**
 * The provider a configured provider names. It answers what it was built from,
 * so a caller can read back the kind and the values that configure it.
 */
export type ConfiguredProvider = LlmProvider & {
  readonly kind: ProviderKindId;
  readonly configuration: readonly ProviderField[];
};

type ProviderBuilder = (
  values: ProviderValues,
  deps: ProviderKindDeps,
) => LlmProvider;

/**
 * A value a kind does not call `secret` is the literal string it reads as: a
 * source belongs to the fields whose value is a credential.
 */
const literalValue = (
  key: string,
  value: SecretSource | undefined,
): string | undefined => {
  if (typeof value === 'function')
    throw new Error(`Provider value ${key} is a literal, not a source.`);

  return value;
};

/** A dependency the factory defaults is passed only when a value names one. */
const baseUrl = (values: ProviderValues): { readonly baseUrl?: string } => {
  const endpoint = literalValue('endpoint', values.endpoint);

  return endpoint === undefined ? {} : { baseUrl: endpoint };
};

const numericValue = (key: string, value: string): number => {
  const parsed = Number(value);

  if (!Number.isFinite(parsed))
    throw new Error(`Provider value ${key} is not a number: ${value}`);

  return parsed;
};

const fedrampValue = (
  value: string | undefined,
): { readonly fedramp?: boolean } => {
  if (value === undefined) return {};
  if (value !== 'true' && value !== 'false')
    throw new Error(`Provider value fedramp is not a flag: ${value}`);

  return { fedramp: value === 'true' };
};

/**
 * Builds each kind through its own factory. A kind's fields are the only values
 * a caller supplies, so a value that is absent leaves the dependency out and the
 * factory's default applies.
 */
const builders: Record<ProviderKindId, ProviderBuilder> = {
  openai: (values, deps) =>
    createOpenAiProvider({
      transport: deps.transport,
      logger: deps.logger,
      identity: deps.identity,
      apiKey: values.token ?? '',
      ...baseUrl(values),
    }),

  openrouter: (values, deps) => {
    const repairs = literalValue(
      'maxStructuredOutputRepairs',
      values.maxStructuredOutputRepairs,
    );

    return createOpenRouterProvider({
      transport: deps.transport,
      logger: deps.logger,
      apiKey: values.token ?? '',
      modelsUrl: literalValue('modelsUrl', values.modelsUrl),
      ...(repairs === undefined
        ? {}
        : {
            maxStructuredOutputRepairs: numericValue(
              'maxStructuredOutputRepairs',
              repairs,
            ),
          }),
      ...baseUrl(values),
    });
  },

  codex: (values, deps) => {
    const chatGptAccountId = literalValue(
      'chatGptAccountId',
      values.chatGptAccountId,
    );

    return createCodexProvider({
      transport: deps.transport,
      logger: deps.logger,
      authorization: values.token ?? '',
      ...(chatGptAccountId === undefined ? {} : { chatGptAccountId }),
      ...fedrampValue(literalValue('fedramp', values.fedramp)),
      ...baseUrl(values),
    });
  },
};

/** A declared value the factory can use: a source, or a literal with something in it. */
const hasValue = (value: SecretSource | undefined): boolean =>
  typeof value === 'function' || (value ?? '').trim() !== '';

/** A required field a provider omits or blanks cannot build its kind. */
const requireValues = (kind: ProviderKind, values: ProviderValues): void => {
  for (const field of kind.fields)
    if (field.required && !hasValue(values[field.key]))
      throw new Error(
        `Provider kind ${kind.id} requires a ${field.key} value.`,
      );
};

export const createProviderForKind = (
  id: ProviderKindId,
  values: ProviderValues,
  deps: ProviderKindDeps,
): ConfiguredProvider => {
  const kind = providerKind(id);

  if (kind === undefined) throw new Error(`Unknown provider kind: ${id}`);

  requireValues(kind, values);

  return {
    ...builders[kind.id](values, deps),
    kind: kind.id,
    configuration: kind.fields,
  };
};
