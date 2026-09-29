import type { Logger } from 'pino';

import type { HttpTransport } from '../types/http.js';
import type { LlmProvider } from '../types/provider.js';
import { codexMetadata, createCodexProvider } from './codex.js';
import { createLmStudioProvider, lmStudioMetadata } from './lmstudio.js';
import {
  createLmStudioOpenAiProvider,
  lmStudioOpenAiMetadata,
} from './lmstudio-openai.js';
import {
  createOpenAiCompatibleProvider,
  createOpenAiProvider,
  openAiMetadata,
  type SecretSource,
} from './openai.js';
import { createOpenRouterProvider, openRouterMetadata } from './openrouter.js';
import {
  createUnifiedProvider,
  defaultStructuredOutputRepairs,
  unifiedMetadata,
} from './unified.js';

/** Every provider integration this package can configure. */
export type ProviderKindId =
  | 'openai'
  | 'openai-compatible'
  | 'openrouter'
  | 'unified'
  | 'codex'
  | 'lmstudio'
  | 'lmstudio-openai';

export type ProviderFieldKind = 'text' | 'url' | 'number' | 'enum' | 'secret';

export type ProviderField = {
  readonly key: string;
  readonly label: string;
  readonly kind: ProviderFieldKind;
  readonly required: boolean;
  readonly description?: string;
  readonly placeholder?: string;
  /** The values an `enum` field offers; present only for `kind: 'enum'`. */
  readonly options?: readonly string[];
};

/** The per-provider lists a kind keeps: edited as tables, read by other sections. */
export type ProviderListId = 'models' | 'reasonings';

export type ProviderKind = {
  readonly id: ProviderKindId;
  readonly label: string;
  readonly description: string;
  /** The values a provider of this kind needs. */
  readonly fields: readonly ProviderField[];
  /** Which per-provider lists this kind keeps. */
  readonly lists: readonly ProviderListId[];
};

/**
 * A base URL. Absent means the factory's own endpoint, which is why the default
 * travels as the placeholder a settings surface shows instead of as a value.
 */
const endpoint = (defaultBaseUrl: string): ProviderField => ({
  key: 'endpoint',
  label: 'Endpoint',
  kind: 'url',
  required: false,
  description: 'Overrides the base URL requests are sent to.',
  placeholder: defaultBaseUrl,
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

/**
 * The OpenAI-shaped kinds keep both lists: their factories enumerate the models
 * they serve and take an effort the operator chooses among. LM Studio's OpenAI
 * compatibility is one of them.
 */
const openAiLists: readonly ProviderListId[] = ['models', 'reasonings'];

/**
 * The provider integrations a configured provider can name, with the values each
 * factory takes. Every field is a factory dependency: `endpoint` is `baseUrl`,
 * `token` is the secret the factory authenticates with, and any other field
 * keeps the factory's own name. A dependency with a literal default becomes an
 * optional field whose placeholder shows that default.
 *
 * `lists` follows what a kind can offer the operator. A kind keeps `models` when
 * its factory can enumerate the models it serves, and `reasonings` when the
 * efforts are the operator's own menu. LM Studio's native server lists the
 * models loaded into it but translates the host's effort onto its own four
 * values, and the ChatGPT Codex backend pins both the model set and the
 * reasoning levels, so neither list belongs on those rows.
 */
export const providerKinds: readonly ProviderKind[] = [
  {
    id: 'openai',
    label: 'OpenAI',
    description: "OpenAI's Responses API at api.openai.com.",
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
    id: 'openai-compatible',
    label: 'OpenAI compatible',
    description:
      'Any endpoint that answers the OpenAI Responses API, under the identity you name.',
    fields: [
      {
        key: 'identityId',
        label: 'Identity ID',
        kind: 'text',
        required: true,
        description: 'The provider id this provider reports as its own.',
      },
      {
        key: 'identityName',
        label: 'Identity name',
        kind: 'text',
        required: true,
        description: 'The provider name this provider reports as its own.',
      },
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
      "OpenRouter's Chat Completions API, including its model catalog.",
    fields: [
      endpoint(openRouterMetadata.baseUrl),
      token({
        required: true,
        description:
          'Names the stored API_TOKEN credential this provider authenticates with.',
      }),
    ],
    lists: openAiLists,
  },
  {
    id: 'unified',
    label: 'Unified (OpenRouter)',
    description:
      'OpenRouter through the unified policy: curated model profiles, live capability discovery, and structured-output repair.',
    fields: [
      endpoint(unifiedMetadata.baseUrl),
      token({
        required: true,
        description:
          'Names the stored API_TOKEN credential this provider authenticates with.',
      }),
      {
        key: 'upstreamModel',
        label: 'Upstream model',
        kind: 'text',
        required: false,
        description:
          'The original model whose curated profile a proxy alias should use.',
      },
      {
        key: 'maxStructuredOutputRepairs',
        label: 'Structured output repairs',
        kind: 'number',
        required: false,
        description:
          'How many corrected attempts a rejected structured response gets.',
        placeholder: String(defaultStructuredOutputRepairs),
      },
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
  {
    id: 'lmstudio',
    label: 'LM Studio',
    description: "A local LM Studio server's own REST API.",
    fields: [
      endpoint(lmStudioMetadata.baseUrl),
      token({
        required: false,
        description:
          'Names the stored API_TOKEN credential to authenticate with. Absent leaves the auth header off, which a local server usually accepts.',
      }),
    ],
    lists: ['models'],
  },
  {
    id: 'lmstudio-openai',
    label: 'LM Studio (OpenAI compatible)',
    description: "A local LM Studio server's OpenAI-compatible API.",
    fields: [
      endpoint(lmStudioOpenAiMetadata.baseUrl),
      token({
        required: false,
        description:
          'Names the stored API_TOKEN credential to authenticate with. Absent leaves the auth header off, which a local server usually accepts.',
      }),
    ],
    lists: openAiLists,
  },
];

/**
 * The kind a configured provider names. A string that names none is not a kind,
 * so a caller decides how to reject it rather than receiving a guess.
 */
export const providerKind = (id: string): ProviderKind | undefined =>
  providerKinds.find((kind) => kind.id === id);

/**
 * The configuration one provider carries: a value per declared field. A `secret`
 * field's value names a stored credential, and a caller may pass that name or a
 * source it reads at call time, so a rotated credential still reaches a provider
 * that was built before the rotation.
 */
export type ProviderValues = Readonly<Record<string, SecretSource>>;

export type ProviderKindDeps = {
  readonly transport: HttpTransport;
  readonly logger: Logger;
};

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
      apiKey: values.token ?? '',
      ...baseUrl(values),
    }),

  'openai-compatible': (values, deps) =>
    createOpenAiCompatibleProvider({
      transport: deps.transport,
      logger: deps.logger,
      identity: {
        id: literalValue('identityId', values.identityId) ?? '',
        name: literalValue('identityName', values.identityName) ?? '',
      },
      apiKey: values.token ?? '',
      ...baseUrl(values),
    }),

  openrouter: (values, deps) =>
    createOpenRouterProvider({
      transport: deps.transport,
      logger: deps.logger,
      apiKey: values.token ?? '',
      ...baseUrl(values),
    }),

  unified: (values, deps) => {
    const upstreamModel = literalValue('upstreamModel', values.upstreamModel);
    const repairs = literalValue(
      'maxStructuredOutputRepairs',
      values.maxStructuredOutputRepairs,
    );

    return createUnifiedProvider({
      transport: deps.transport,
      logger: deps.logger,
      apiKey: values.token ?? '',
      ...(upstreamModel === undefined ? {} : { upstreamModel }),
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

  lmstudio: (values, deps) =>
    createLmStudioProvider({
      transport: deps.transport,
      logger: deps.logger,
      apiKey: values.token ?? '',
      ...baseUrl(values),
    }),

  'lmstudio-openai': (values, deps) =>
    createLmStudioOpenAiProvider({
      transport: deps.transport,
      logger: deps.logger,
      apiKey: values.token ?? '',
      ...baseUrl(values),
    }),
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
