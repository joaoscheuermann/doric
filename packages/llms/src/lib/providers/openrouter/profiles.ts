export type OpenRouterLab =
  | 'openai'
  | 'anthropic'
  | 'gemini'
  | 'gemma'
  | 'deepseek'
  | 'kimi'
  | 'mistral'
  | 'qwen'
  | 'llama'
  | 'xai'
  | 'glm'
  | 'cohere'
  | 'minimax'
  | 'unknown';

export interface OpenRouterModelProfile {
  readonly lab: OpenRouterLab;
  readonly tools: boolean;
  readonly forcedToolChoice: 'full' | 'auto_none';
  readonly forcedToolChoiceWithReasoning: boolean;
  readonly replay: 'all' | 'tool_calls';
  readonly strictTools: boolean;
}

const profile = (
  lab: OpenRouterLab,
  overrides: Partial<Omit<OpenRouterModelProfile, 'lab'>> = {},
): OpenRouterModelProfile => ({
  lab,
  tools: true,
  forcedToolChoice: 'full',
  forcedToolChoiceWithReasoning: true,
  replay: 'all',
  strictTools: false,
  ...overrides,
});

const knownProfiles: readonly {
  readonly prefix: string;
  readonly profile: OpenRouterModelProfile;
}[] = [
  {
    prefix: 'google/gemma',
    profile: profile('gemma', {
      forcedToolChoice: 'auto_none',
      replay: 'tool_calls',
    }),
  },
  { prefix: 'google/', profile: profile('gemini', { strictTools: true }) },
  { prefix: 'openai/', profile: profile('openai', { strictTools: true }) },
  {
    prefix: 'anthropic/',
    profile: profile('anthropic', {
      forcedToolChoiceWithReasoning: false,
      strictTools: true,
    }),
  },
  { prefix: 'deepseek/', profile: profile('deepseek') },
  { prefix: 'moonshotai/', profile: profile('kimi') },
  { prefix: 'mistralai/', profile: profile('mistral', { strictTools: true }) },
  { prefix: 'qwen/', profile: profile('qwen', { replay: 'tool_calls' }) },
  {
    prefix: 'meta-llama/',
    profile: profile('llama', {
      forcedToolChoice: 'auto_none',
      replay: 'tool_calls',
    }),
  },
  { prefix: 'x-ai/', profile: profile('xai', { strictTools: true }) },
  {
    prefix: 'z-ai/',
    profile: profile('glm', { forcedToolChoice: 'auto_none' }),
  },
  { prefix: 'cohere/', profile: profile('cohere') },
  {
    prefix: 'minimax/',
    profile: profile('minimax', { forcedToolChoice: 'auto_none' }),
  },
];

const unknownProfile = profile('unknown', {
  tools: false,
  forcedToolChoice: 'auto_none',
  forcedToolChoiceWithReasoning: false,
  replay: 'tool_calls',
});

export const openRouterProfileForModel = (
  model: string,
): OpenRouterModelProfile =>
  knownProfiles.find(({ prefix }) => model.startsWith(prefix))?.profile ??
  unknownProfile;
