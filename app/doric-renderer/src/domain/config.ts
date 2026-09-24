/**
 * The credential-free configuration the host owns: the providers Doric may call,
 * the model execution uses, and how many turns one prompt may take. The host
 * re-validates every rule below and answers `422`, so this module's job is to
 * keep Save off and say why before a request leaves the renderer.
 */

export const reasoningEfforts = [
  'none',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
] as const;

export type ReasoningEffort = (typeof reasoningEfforts)[number];

export type ProviderConfiguration = {
  readonly id: string;
  readonly baseUrl: string;
  readonly apiKeyEnv: string;
};

export type Configuration = {
  readonly providers: readonly ProviderConfiguration[];
  readonly models: {
    readonly execution: ModelExecution;
  };
  readonly execution: { readonly maxTurns: number };
};

export type ModelExecution = {
  readonly providerId: string;
  readonly model: string;
  readonly effort: ReasoningEffort;
};

export type DoricConfiguration = {
  readonly configuration: Configuration;
  readonly revision: number;
  readonly updatedAt: string;
};

/** The bounds the host enforces on a provider id and on a model name. */
const providerIdLimit = 128;
const modelLimit = 512;

/** The environment variable holding an API key, named and not spelled out. */
const apiKeyEnvPattern = /^[A-Z][A-Z0-9_]*_API_KEY$/;

const isHttpUrl = (value: string): boolean => {
  try {
    const { protocol } = new URL(value);
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
};

/**
 * What a provider row is called: its id once the user has given it one, and its
 * place in the list while it is still unnamed.
 */
export const providerLabel = (
  provider: ProviderConfiguration,
  index: number,
): string =>
  provider.id.trim() === '' ? `Provider ${index + 1}` : provider.id;

/** The name a reasoning effort is shown under. */
export const effortLabel = (effort: ReasoningEffort): string =>
  effort.charAt(0).toUpperCase() + effort.slice(1);

/** The turn limit a text field names, or `NaN` while it names none. */
export const turnsFromInput = (value: string): number => {
  const trimmed = value.trim();
  return trimmed === '' ? Number.NaN : Number(trimmed);
};

/** The host's `updatedAt` as a reader sees it, or verbatim when unreadable. */
export const updatedAtLabel = (updatedAt: string): string => {
  const at = new Date(updatedAt);
  return Number.isNaN(at.getTime()) ? updatedAt : at.toLocaleString();
};

/**
 * The first reason the host would refuse this configuration, in the voice the
 * rest of the surface uses, or `undefined` when it would accept it. The rules
 * are the host's, in the order a person would fix them: a usable provider list
 * first, then the model that runs against it, then the turn limit.
 */
export const configurationIssue = (
  configuration: Configuration,
): string | undefined => {
  const { providers } = configuration;
  if (providers.length === 0) return 'Add at least one provider.';

  const ids = new Set<string>();
  for (const provider of providers) {
    if (
      provider.id.trim() === '' ||
      Array.from(provider.id).length > providerIdLimit
    ) {
      return `Enter an id between 1 and ${providerIdLimit} characters for every provider.`;
    }
    if (ids.has(provider.id)) return 'Provider ids must be unique.';
    ids.add(provider.id);

    if (!isHttpUrl(provider.baseUrl)) {
      return `Enter an http:// or https:// base URL for ${provider.id}.`;
    }
    if (!apiKeyEnvPattern.test(provider.apiKeyEnv)) {
      return `Enter the API-key environment variable for ${provider.id}, like OPENAI_API_KEY.`;
    }
  }

  const { effort, model, providerId } = configuration.models.execution;
  if (!ids.has(providerId)) return 'Choose the provider that runs prompts.';
  if (model.trim() === '' || Array.from(model).length > modelLimit) {
    return `Enter a model between 1 and ${modelLimit} characters.`;
  }
  if (!reasoningEfforts.includes(effort)) return 'Choose a reasoning effort.';
  if (
    !Number.isInteger(configuration.execution.maxTurns) ||
    configuration.execution.maxTurns < 1
  ) {
    return 'Enter a turn limit of 1 or more.';
  }
  return undefined;
};

const isSameProvider = (
  left: ProviderConfiguration,
  right: ProviderConfiguration,
): boolean =>
  left.id === right.id &&
  left.baseUrl === right.baseUrl &&
  left.apiKeyEnv === right.apiKeyEnv;

/**
 * Whether two configurations describe the same host state. The host owns the
 * configuration, so Save is offered only when the draft differs from the copy
 * the host returned.
 */
export const isSameConfiguration = (
  left: Configuration,
  right: Configuration,
): boolean =>
  left.providers.length === right.providers.length &&
  left.providers.every((provider, index) =>
    isSameProvider(provider, right.providers[index]),
  ) &&
  left.models.execution.providerId === right.models.execution.providerId &&
  left.models.execution.model === right.models.execution.model &&
  left.models.execution.effort === right.models.execution.effort &&
  left.execution.maxTurns === right.execution.maxTurns;

/** The configuration with the execution model pointed at one provider. */
const withExecutionProvider = (
  configuration: Configuration,
  providerId: string,
): Configuration => ({
  ...configuration,
  models: {
    execution: { ...configuration.models.execution, providerId },
  },
});

/** Appends an unnamed row for the user to fill in. */
export const addProvider = (configuration: Configuration): Configuration => ({
  ...configuration,
  providers: [
    ...configuration.providers,
    { id: '', baseUrl: '', apiKeyEnv: '' },
  ],
});

/**
 * Patches one row by position. Renaming the row the execution model references
 * moves the reference with it, so a rename cannot leave it dangling.
 */
export const updateProvider = (
  configuration: Configuration,
  index: number,
  patch: Partial<ProviderConfiguration>,
): Configuration => {
  const provider = configuration.providers[index];
  if (provider === undefined) return configuration;

  const providers = configuration.providers.map((current, currentIndex) =>
    currentIndex === index ? { ...current, ...patch } : current,
  );
  const next = { ...configuration, providers };
  const renamed = patch.id !== undefined && patch.id !== provider.id;
  return renamed && configuration.models.execution.providerId === provider.id
    ? withExecutionProvider(next, patch.id)
    : next;
};

/**
 * Drops the row at a position, the same identity `updateProvider` addresses.
 * A row is not addressable by id yet: an added row has none, and a row being
 * typed may carry a duplicate, so an id would remove two rows at once. The
 * execution model must keep naming a configured provider, so when the removed
 * row was the referenced one the reference moves to the first row left, or to
 * none when the list empties.
 */
export const removeProvider = (
  configuration: Configuration,
  index: number,
): Configuration => {
  const removed = configuration.providers[index];
  if (removed === undefined) return configuration;

  const providers = configuration.providers.filter(
    (_, current) => current !== index,
  );
  const next = { ...configuration, providers };
  return configuration.models.execution.providerId === removed.id
    ? withExecutionProvider(next, providers[0]?.id ?? '')
    : next;
};

/** Patches the model execution runs. */
export const updateModel = (
  configuration: Configuration,
  patch: Partial<ModelExecution>,
): Configuration => ({
  ...configuration,
  models: { execution: { ...configuration.models.execution, ...patch } },
});

/** Sets how many turns one prompt may take. */
export const updateTurnLimit = (
  configuration: Configuration,
  maxTurns: number,
): Configuration => ({
  ...configuration,
  execution: { ...configuration.execution, maxTurns },
});
