// The host side of the settings bundle and of chat's model mark: the core's
// `models/v1`, `secrets/v1` and `tools/v1` and the host-config bundle's
// `host-config/v1`, answered over Connect as the prototype draws them
// (Figma `99:8035`'s footer "anthropic/claude-sonnet-4.5 · Medium" and its
// ✳︎ agent mark; the settings window's providers OpenRouter, OpenAI and a
// local endpoint, `35:8964`). Shapes follow the contracts' schemas and the
// settings stories' fixtures (`bundles/desktop/settings/stories/support`).

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { toJson } from '@bufbuild/protobuf';
import { ValueSchema } from '@bufbuild/protobuf/wkt';
import type { ConnectRouter } from '@connectrpc/connect';
import {
  CatalogResponseSchema,
  KindResponseSchema,
  KindsResponseSchema,
  ModelsService,
} from 'bundle/contracts/gen/doric/models/v1/models_pb.js';
import {
  ListResponseSchema,
  SecretsService,
} from 'bundle/contracts/gen/doric/secrets/v1/secrets_pb.js';
import { ToolsService } from 'bundle/contracts/gen/doric/tools/v1/tools_pb.js';
import {
  CurrentResponseSchema,
  HostConfigService,
  ReplaceResponseSchema,
} from 'host-config/contracts/gen/doric/host_config/v1/host_config_pb.js';
import { encode } from 'runtime/contracts';

/** The provider and model the prototype's execution picker names. */
export const EXECUTION = {
  providerId: 'openrouter',
  model: 'anthropic/claude-sonnet-4.5',
  effort: 'medium',
} as const;

/** Placeholder credential ids, in the UUID shape a `secret` field names. */
const CREDENTIALS = {
  openRouter: '00000000-0000-4000-8000-000000000001',
  openAi: '00000000-0000-4000-8000-000000000002',
} as const;

const tokenField = (required: boolean) => ({
  key: 'token',
  label: 'Token',
  kind: 'secret',
  required,
  description:
    'Names the stored API_TOKEN credential this provider authenticates with.',
});

const endpointField = (placeholder: string) => ({
  key: 'endpoint',
  label: 'Endpoint',
  kind: 'url',
  required: false,
  advanced: true,
  description: 'Overrides the base URL requests are sent to.',
  placeholder,
});

/** The provider kinds the host declares (`models/v1.kinds`). */
const KINDS = [
  {
    id: 'openrouter',
    label: 'OpenRouter',
    description:
      'OpenRouter Chat Completions with curated model profiles, live capability discovery, and structured-output repair.',
    fields: [endpointField('https://openrouter.ai/api/v1'), tokenField(true)],
    lists: ['models', 'reasonings'],
  },
  {
    id: 'openai',
    label: 'OpenAI',
    description:
      'Any endpoint that answers the OpenAI Responses API, under its own identity.',
    fields: [endpointField('https://api.openai.com/v1'), tokenField(false)],
    lists: ['models', 'reasonings'],
  },
] as const;

/** OpenRouter's live catalog (`models/v1.catalog`). */
const OPENROUTER_CATALOG = [
  {
    id: 'anthropic/claude-sonnet-4.5',
    name: 'Anthropic: Claude Sonnet 4.5',
    reasonings: ['low', 'medium', 'high'],
    parameters: ['tools', 'tool_choice', 'reasoning', 'structured_outputs'],
    defaultEffort: 'medium',
    mandatory: false,
  },
  {
    id: 'deepseek/deepseek-v3.2',
    name: 'DeepSeek: DeepSeek V3.2',
    reasonings: ['low', 'medium', 'high'],
    parameters: ['tools', 'tool_choice', 'reasoning', 'temperature'],
    mandatory: false,
  },
  {
    id: 'meta-llama/llama-4-maverick',
    name: 'Meta: Llama 4 Maverick',
    reasonings: [],
    parameters: ['tools', 'temperature'],
    mandatory: false,
  },
];

/** The stored configuration (`host-config/v1.current`): three providers. */
const CONFIGURATION = {
  providers: [
    {
      id: 'openrouter',
      kind: 'openrouter',
      configuration: { token: CREDENTIALS.openRouter },
      models: [
        {
          name: 'anthropic/claude-sonnet-4.5',
          reasonings: ['low', 'medium', 'high'],
          defaultEffort: 'medium',
        },
        {
          name: 'deepseek/deepseek-v3.2',
          reasonings: ['low', 'medium', 'high'],
        },
        { name: 'meta-llama/llama-4-maverick', reasonings: [] },
      ],
    },
    {
      id: 'openai',
      kind: 'openai',
      configuration: {
        endpoint: 'https://api.openai.com/v1',
        token: CREDENTIALS.openAi,
      },
      models: [
        {
          name: 'gpt-5',
          reasonings: ['minimal', 'low', 'medium', 'high'],
          defaultEffort: 'medium',
        },
        { name: 'gpt-5-mini', reasonings: ['low', 'medium', 'high'] },
      ],
    },
    {
      id: 'local',
      kind: 'openai',
      configuration: { endpoint: 'http://localhost:11434/v1' },
      models: [{ name: 'qwen3-coder:30b', reasonings: [] }],
    },
  ],
  models: { execution: { ...EXECUTION } },
  execution: { maxTurns: 32 },
};

const STORED = {
  configuration: CONFIGURATION,
  revision: 42,
  updatedAt: '2026-01-05T08:30:00.000Z',
};

/** The stored credentials (`secrets/v1.list`): the providers' two tokens. */
const SECRETS = [
  {
    id: CREDENTIALS.openRouter,
    kind: 'API_TOKEN',
    name: 'OpenRouter key',
    hasSecret: true,
  },
  {
    id: CREDENTIALS.openAi,
    kind: 'API_TOKEN',
    name: 'OpenAI key',
    hasSecret: true,
  },
];

/**
 * The LobeHub marks the host's icon catalog serves, read from the source
 * `packages/llms` ships them in, so the marks are the real ones.
 */
const lobehubIcons = (): Record<string, string> => {
  const source = readFileSync(
    resolve('packages/llms/src/lib/icons/lobehub.ts'),
    'utf8',
  );

  return Object.fromEntries(
    [...source.matchAll(/^ {2}([a-z]+):\s*'(<svg[^']*)'/gm)].map((match) => [
      match[1] as string,
      match[2] as string,
    ]),
  );
};

/** A model's own icon by its id's vendor, as the host's fallback picks it. */
const modelIcon = (model: string): string | null => {
  if (model.startsWith('anthropic/') || model.startsWith('claude')) {
    return 'claude';
  }
  if (model.startsWith('deepseek')) return 'deepseek';
  if (model.startsWith('google/') || model.startsWith('gemini')) {
    return 'gemini';
  }
  if (model.startsWith('meta-llama/')) return 'meta';
  if (model.startsWith('qwen')) return 'qwen';
  if (model.startsWith('openai/') || model.startsWith('gpt-')) return 'openai';

  return null;
};

/** A provider kind's own icon. */
const kindIcon = (kind: string | undefined): string | undefined =>
  kind === 'openrouter'
    ? 'openrouter'
    : kind === 'openai'
      ? 'openai'
      : undefined;

interface IconRequest {
  readonly providerId?: string;
  readonly kind?: string;
  readonly models: readonly string[];
}

/**
 * `models/v1.icons`' answer to `requests` over `icons`: each model's own icon,
 * the provider kind's own, or `null` for none, and the SVG of each name used.
 */
const iconAnswers = (
  icons: Readonly<Record<string, string>>,
  requests: readonly IconRequest[],
) => {
  const answers = requests.map((request) => {
    const kind =
      request.kind ??
      CONFIGURATION.providers.find(
        (provider) => provider.id === request.providerId,
      )?.kind;
    const provider = kindIcon(kind);
    const known = (name: string | null | undefined) =>
      name !== null && name !== undefined && icons[name] !== undefined
        ? name
        : null;

    return {
      ...(known(provider) === null ? {} : { provider }),
      models: request.models.map((model) => known(modelIcon(model))),
    };
  });
  const used = new Set(
    answers.flatMap((answer) => [
      ...(answer.provider === undefined ? [] : [answer.provider]),
      ...answer.models.filter((name): name is string => name !== null),
    ]),
  );

  return {
    svgs: Object.fromEntries(
      [...used].flatMap((name) =>
        icons[name] === undefined ? [] : [[name, icons[name]]],
      ),
    ),
    answers,
  };
};

/**
 * The settings window's host contracts over Connect, as the core and
 * host-config serve them (`HostConfigService`, `ModelsService`,
 * `ToolsService.Catalog`, `SecretsService.List`; slice S65c), with chat's
 * agent mark (`ModelsService.Icons`, slice S65a): the fixtures above,
 * written as the wire's messages with the host's codec
 * (`encode`), a model without an icon as `""`. A replaced configuration is
 * kept, so later reads answer it. `record` hears each method called,
 * `<Service>/<Method>`.
 */
export const serveSettingsConnect = (
  router: ConnectRouter,
  record: (method: string) => void = () => undefined,
): void => {
  const icons = lobehubIcons();
  let stored: unknown = STORED;

  router.service(ModelsService, {
    kinds: () => {
      record('ModelsService/Kinds');
      return encode(KindsResponseSchema, { kinds: KINDS });
    },
    kind: ({ id }) => {
      record('ModelsService/Kind');
      const kind = KINDS.find((item) => item.id === id);

      return encode(
        KindResponseSchema,
        kind === undefined ? {} : { modelKindDescriptor: kind },
      );
    },
    catalog: ({ kind }) => {
      record('ModelsService/Catalog');
      return encode(CatalogResponseSchema, {
        catalogResult:
          kind === 'openrouter'
            ? { status: 'read', models: OPENROUTER_CATALOG }
            : { status: 'absent' },
      });
    },
    icons: ({ requests }) => {
      record('ModelsService/Icons');
      const { svgs, answers } = iconAnswers(
        icons,
        requests.map(({ providerId, kind, models }) => ({
          ...(providerId === undefined ? {} : { providerId }),
          ...(kind === undefined ? {} : { kind }),
          models,
        })),
      );

      return {
        svgs,
        answers: answers.map(({ models, ...answer }) => ({
          ...answer,
          models: models.map((name) => name ?? ''),
        })),
      };
    },
  });
  router.service(HostConfigService, {
    current: () => {
      record('HostConfigService/Current');
      return encode(CurrentResponseSchema, { doricConfiguration: stored });
    },
    replace: ({ input }) => {
      record('HostConfigService/Replace');
      stored = {
        configuration:
          input === undefined ? undefined : toJson(ValueSchema, input),
        revision: (stored as typeof STORED).revision + 1,
        updatedAt: STORED.updatedAt,
      };

      return encode(ReplaceResponseSchema, {
        status: 'replaced',
        config: stored,
      });
    },
  });
  router.service(SecretsService, {
    list: () => {
      record('SecretsService/List');
      return encode(ListResponseSchema, { credentials: SECRETS });
    },
  });
  router.service(ToolsService, {
    catalog: () => {
      record('ToolsService/Catalog');
      return { entries: [] };
    },
  });
};
