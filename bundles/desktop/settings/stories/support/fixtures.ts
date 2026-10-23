// What the settings stories are seeded with: the host's provider catalog, its
// tool catalog, the stored credentials and one stored configuration, in the
// shapes the settings domain reads. Every id and secret here is an obvious
// placeholder; no story reaches a real host or holds a real key.

import type {
  CatalogModel,
  Configuration,
  Credential,
  DoricConfiguration,
  ProviderKind,
  ToolCatalogEntry,
} from '../../src/client/domain/config.js';

/** Placeholder credential ids, in the UUID shape a `secret` field names. */
export const credentialIds = {
  openRouter: '00000000-0000-4000-8000-000000000001',
  openAi: '00000000-0000-4000-8000-000000000002',
  registry: '00000000-0000-4000-8000-000000000003',
  git: '00000000-0000-4000-8000-000000000004',
  github: '00000000-0000-4000-8000-000000000005',
  claude: '00000000-0000-4000-8000-000000000006',
} as const;

/**
 * OpenRouter as the host declares it: a token, and two advanced fields. Its
 * `modelsUrl` field is what makes its models a catalog pick rather than a list
 * typed by hand.
 */
export const openRouterKind: ProviderKind = {
  id: 'openrouter',
  label: 'OpenRouter',
  description:
    'OpenRouter Chat Completions with curated model profiles, live capability discovery, and structured-output repair.',
  fields: [
    {
      key: 'endpoint',
      label: 'Endpoint',
      kind: 'url',
      required: false,
      advanced: true,
      description: 'Overrides the base URL requests are sent to.',
      placeholder: 'https://openrouter.ai/api/v1',
    },
    {
      key: 'token',
      label: 'Token',
      kind: 'secret',
      required: true,
      description:
        'Names the stored API_TOKEN credential this provider authenticates with.',
    },
    {
      key: 'maxStructuredOutputRepairs',
      label: 'Structured output repairs',
      kind: 'number',
      required: false,
      advanced: true,
      description:
        'How many corrected attempts a rejected structured response gets.',
      placeholder: '2',
    },
    {
      key: 'modelsUrl',
      label: 'Models URL',
      kind: 'url',
      required: false,
      advanced: true,
      description:
        'Where this provider lists the models it serves and what each one accepts.',
      placeholder: 'https://openrouter.ai/api/v1/models',
    },
  ],
  lists: ['models', 'reasonings'],
};

/** OpenAI: its models and their efforts are typed by hand. */
export const openAiKind: ProviderKind = {
  id: 'openai',
  label: 'OpenAI',
  description:
    'Any endpoint that answers the OpenAI Responses API, under its own identity.',
  fields: [
    {
      key: 'endpoint',
      label: 'Endpoint',
      kind: 'url',
      required: false,
      advanced: true,
      description: 'Overrides the base URL requests are sent to.',
      placeholder: 'https://api.openai.com/v1',
    },
    {
      key: 'token',
      label: 'Token',
      kind: 'secret',
      required: false,
      description:
        'Names the stored API_TOKEN credential to authenticate with. Absent leaves the auth header off, which a compatible endpoint may accept.',
    },
  ],
  lists: ['models', 'reasonings'],
};

/** Codex: no model list at all, and an `enum` field. */
export const codexKind: ProviderKind = {
  id: 'codex',
  label: 'Codex',
  description:
    'The ChatGPT Codex Responses backend, authenticated with a Codex authorization value.',
  fields: [
    {
      key: 'endpoint',
      label: 'Endpoint',
      kind: 'url',
      required: false,
      advanced: true,
      description: 'Overrides the base URL requests are sent to.',
      placeholder: 'https://chatgpt.com/backend-api/codex',
    },
    {
      key: 'token',
      label: 'Token',
      kind: 'secret',
      required: true,
      description:
        'Names the stored API_TOKEN credential that carries the Codex authorization value.',
    },
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
};

/**
 * Claude: the Claude Code subscription login, signed in from the provider
 * page's own sign-in row.
 */
export const claudeKind: ProviderKind = {
  id: 'claude',
  label: 'Claude',
  description: 'Anthropic Messages through a Claude Code subscription login.',
  fields: [
    {
      key: 'endpoint',
      label: 'Endpoint',
      kind: 'url',
      required: false,
      advanced: true,
      description: 'Overrides the base URL requests are sent to.',
      placeholder: 'https://api.anthropic.com',
    },
    {
      key: 'token',
      label: 'Token',
      kind: 'secret',
      required: true,
      description:
        'Names the stored API_TOKEN credential that carries the Claude authorization value.',
    },
  ],
  lists: [],
};

export const providerKinds: readonly ProviderKind[] = [
  openRouterKind,
  openAiKind,
  codexKind,
  claudeKind,
];

/** The credential a Claude sign-in answers: the stored Claude token. */
export const claudeCredential: Credential = {
  id: credentialIds.claude,
  kind: 'API_TOKEN',
  name: 'Claude',
  hasSecret: true,
};

export const credentials: readonly Credential[] = [
  {
    id: credentialIds.openRouter,
    kind: 'API_TOKEN',
    name: 'OpenRouter key',
    hasSecret: true,
  },
  {
    id: credentialIds.openAi,
    kind: 'API_TOKEN',
    name: 'OpenAI key',
    hasSecret: true,
  },
  {
    id: credentialIds.registry,
    kind: 'USERNAME_PASSWORD',
    name: 'Package registry',
    username: 'doric-ci',
    hasSecret: false,
  },
  {
    id: credentialIds.git,
    kind: 'GIT',
    name: 'Doric commits',
    username: 'Doric Agent',
    email: 'agent@example.com',
    hasSecret: false,
  },
  {
    id: credentialIds.github,
    kind: 'API_TOKEN',
    name: 'GitHub token',
    hasSecret: true,
  },
  claudeCredential,
];

/** Credentials with no `API_TOKEN`, so no provider can name one. */
export const credentialsWithoutTokens: readonly Credential[] =
  credentials.filter((credential) => credential.kind !== 'API_TOKEN');

/** Many credentials, so the table pages. */
export const manyCredentials: readonly Credential[] = [
  ...credentials,
  ...Array.from({ length: 18 }, (_, index) => ({
    id: `00000000-0000-4000-8000-1000000000${String(index).padStart(2, '0')}`,
    kind: 'API_TOKEN' as const,
    name: `Project key ${index + 1}`,
    hasSecret: index % 3 !== 0,
  })),
];

/** The tools the loaded bundles expose, two of them with settings. */
export const toolCatalog: readonly ToolCatalogEntry[] = [
  {
    name: 'web_search',
    description: 'Searches the web and returns the top results with snippets.',
    settings: [
      {
        key: 'engine',
        label: 'Search engine',
        kind: 'enum',
        required: true,
        default: 'brave',
        options: ['brave', 'bing', 'duckduckgo'],
        description: 'Which search API answers a query.',
      },
      {
        key: 'maxResults',
        label: 'Results per query',
        kind: 'number',
        required: false,
        default: '8',
        placeholder: '8',
        description: 'How many results one search returns to the agent.',
      },
    ],
  },
  {
    name: 'fetch',
    description: 'Reads one web page as Markdown.',
    settings: [
      {
        key: 'userAgent',
        label: 'User agent',
        kind: 'text',
        required: false,
        placeholder: 'Doric/1.0',
        description: 'Sent with every request the tool makes.',
      },
      {
        key: 'proxy',
        label: 'Proxy',
        kind: 'url',
        required: false,
        placeholder: 'http://localhost:8080',
      },
    ],
  },
  { name: 'read_file', description: 'Reads a Project file.', settings: [] },
];

/** The models the OpenRouter endpoint lists, as the host read them. */
export const openRouterCatalog: readonly CatalogModel[] = [
  {
    id: 'anthropic/claude-sonnet-4.5',
    name: 'Anthropic: Claude Sonnet 4.5',
    reasonings: ['low', 'medium', 'high'],
    parameters: ['tools', 'tool_choice', 'reasoning', 'structured_outputs'],
  },
  {
    id: 'deepseek/deepseek-v3.2',
    name: 'DeepSeek: DeepSeek V3.2',
    reasonings: ['low', 'medium', 'high'],
    parameters: ['tools', 'tool_choice', 'reasoning', 'temperature'],
  },
  {
    id: 'google/gemini-2.5-pro',
    name: 'Google: Gemini 2.5 Pro',
    reasonings: ['low', 'medium', 'high'],
    parameters: [
      'tools',
      'tool_choice',
      'reasoning',
      'structured_outputs',
      'temperature',
    ],
  },
  {
    id: 'openai/gpt-5',
    name: 'OpenAI: GPT-5',
    reasonings: ['minimal', 'low', 'medium', 'high'],
    parameters: [
      'tools',
      'tool_choice',
      'parallel_tool_calls',
      'reasoning',
      'structured_outputs',
    ],
  },
  {
    id: 'meta-llama/llama-4-maverick',
    name: 'Meta: Llama 4 Maverick',
    reasonings: [],
    parameters: ['tools', 'temperature'],
  },
  {
    id: 'mistralai/mistral-small-3.2',
    name: 'Mistral: Mistral Small 3.2',
    reasonings: [],
    parameters: ['temperature'],
  },
];

/** A catalog long enough to page, as a large endpoint lists. */
export const largeCatalog: readonly CatalogModel[] = [
  ...openRouterCatalog,
  ...Array.from({ length: 40 }, (_, index) => ({
    id: `vendor/model-${String(index + 1).padStart(2, '0')}`,
    name: `Vendor: Model ${index + 1}`,
    reasonings: index % 2 === 0 ? (['low', 'high'] as const) : [],
    parameters: index % 3 === 0 ? ['tools', 'temperature'] : ['temperature'],
  })),
];

/** The configuration the host stores: three providers, OpenRouter running. */
export const configuration: Configuration = {
  providers: [
    {
      id: 'openrouter',
      kind: 'openrouter',
      configuration: { token: credentialIds.openRouter },
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
        token: credentialIds.openAi,
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
  models: {
    execution: {
      providerId: 'openrouter',
      model: 'anthropic/claude-sonnet-4.5',
      effort: 'medium',
    },
  },
  execution: { maxTurns: 32, maxToolResultChars: 20000 },
  tools: { web_search: { engine: 'brave', maxResults: '8' } },
  gitCredentialId: credentialIds.git,
  githubCredentialId: credentialIds.github,
};

/** One provider whose models list nothing, so every model is typed by hand. */
export const bareConfiguration: Configuration = {
  providers: [
    {
      id: 'openai',
      kind: 'openai',
      configuration: { token: credentialIds.openAi },
      models: [],
    },
  ],
  models: { execution: { providerId: 'openai', model: 'gpt-5' } },
  execution: { maxTurns: 32 },
};

/** A configuration with no provider yet, which the host would refuse to save. */
export const emptyConfiguration: Configuration = {
  providers: [],
  models: { execution: { providerId: '', model: '' } },
  execution: { maxTurns: 32 },
};

/** The stored configuration as the host answers it, with its revision. */
export const storedConfiguration = (
  value: Configuration = configuration,
): DoricConfiguration => ({
  configuration: value,
  revision: 42,
  updatedAt: '2026-10-14T09:30:00.000Z',
});
