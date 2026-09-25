/**
 * The configuration the host owns: the providers Doric may call, the model
 * execution uses, how many turns one prompt may take, and the GitHub
 * credentials the agent's git commands use. The host re-validates every rule
 * below and answers `422`, so this module's job is to say why a draft cannot be
 * sent before a request leaves the renderer.
 *
 * Exactly one field is write-only. The host answers whether it holds a GitHub
 * token and never the token itself, so a draft carries only what the token
 * field currently holds, and `configurationInput` is what turns a draft into
 * the body a save sends.
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

/**
 * GitHub as the host holds it: the username, the email, and whether a token is
 * stored. `token` is the one field the host never answers with — it is the
 * token field's current text, absent until someone types one and empty again
 * once a save has returned the host's copy.
 */
export type GitHubConfiguration = {
  readonly username: string;
  readonly email: string;
  readonly hasToken: boolean;
  readonly token?: string;
};

/**
 * The GitHub block a save sends. A token replaces the stored one, `null` keeps
 * it and `''` clears it; the field itself only ever produces the first two.
 */
export type GitHubInput = {
  readonly username: string;
  readonly email: string;
  readonly token?: string | null;
};

export type Configuration = {
  readonly providers: readonly ProviderConfiguration[];
  readonly models: {
    readonly execution: ModelExecution;
  };
  readonly execution: { readonly maxTurns: number };
  /** Absent until GitHub credentials are given; a blank block means none are. */
  readonly github?: GitHubConfiguration;
};

/**
 * The configuration as a save sends it: the same, with GitHub's write-only
 * block in place of the one the host answers with. `github` absent leaves the
 * stored block alone, `github: null` removes it, and a block sets it — a secret
 * is never deleted by a caller that simply omits the key.
 */
export type ConfigurationInput = Omit<Configuration, 'github'> & {
  readonly github?: GitHubInput | null;
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

/** The bounds the host enforces on a GitHub username, email and token. */
const usernameLimit = 128;
const emailLimit = 254;
const tokenLimit = 512;

/**
 * A GitHub token carries no whitespace or control character, which is what lets
 * the field refuse a pasted line break instead of trimming a credential.
 */
const tokenPattern = /^[\x21-\x7e]+$/;
const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

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

/**
 * The token field's text. A stored token is never read back, so this is only
 * ever what someone typed into the draft, and an empty field is what keeps the
 * token the host already holds.
 */
export const tokenFieldText = (
  github: GitHubConfiguration | undefined,
): string => github?.token ?? '';

/**
 * What the token field says about the token the host holds: whether an empty
 * field keeps one, rather than the field having nothing to say.
 */
export const storedTokenNotice = (
  github: GitHubConfiguration | undefined,
): string =>
  github?.hasToken === true
    ? 'A token is stored; leave this field empty to keep it.'
    : 'No token is stored yet.';

/**
 * Whether the block holds anything at all. A blank username and email are the
 * state of a section nobody has filled in, which the host reads as none being
 * configured, so it is a state rather than something to complain about. A token
 * on its own is the exception: the host stores a token only beside the identity
 * it belongs to, so a token still asks who it is for.
 */
const holdsCredential = (github: GitHubConfiguration): boolean =>
  github.username.trim() !== '' ||
  github.email.trim() !== '' ||
  tokenFieldText(github) !== '';

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
 * first, then the model that runs against it, then the turn limit, then the
 * GitHub credentials.
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

  const { github } = configuration;
  if (github !== undefined && holdsCredential(github)) {
    const username = github.username.trim();
    if (username === '' || Array.from(username).length > usernameLimit) {
      return `Enter a GitHub username between 1 and ${usernameLimit} characters.`;
    }
    const email = github.email.trim();
    if (
      email === '' ||
      Array.from(email).length > emailLimit ||
      !emailPattern.test(email)
    ) {
      return 'Enter a GitHub email address.';
    }
    const token = tokenFieldText(github);
    if (token !== '') {
      if (Array.from(token).length > tokenLimit) {
        return `Enter a GitHub token of at most ${tokenLimit} characters.`;
      }
      if (!tokenPattern.test(token)) {
        return 'Enter a GitHub token with no spaces or line breaks, or leave the field empty.';
      }
    }
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
 * The block as the host sees it: a block nobody filled in is no block at all,
 * which is the state a cleared section is in.
 */
const configuredGitHub = (
  github: GitHubConfiguration | undefined,
): GitHubConfiguration | undefined =>
  github === undefined || !holdsCredential(github) ? undefined : github;

/**
 * Whether two GitHub blocks describe the same host state, with the token
 * compared as the field's text: a token typed into an otherwise unchanged draft
 * is a change worth sending, and an empty field is not.
 */
const isSameGitHub = (
  left: GitHubConfiguration | undefined,
  right: GitHubConfiguration | undefined,
): boolean => {
  const one = configuredGitHub(left);
  const other = configuredGitHub(right);
  if (one === undefined || other === undefined) return one === other;
  return (
    one.username === other.username &&
    one.email === other.email &&
    one.hasToken === other.hasToken &&
    tokenFieldText(one) === tokenFieldText(other)
  );
};

/**
 * Whether two configurations describe the same host state. The host owns the
 * configuration, so a change is sent only when the draft differs from the copy
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
  left.execution.maxTurns === right.execution.maxTurns &&
  isSameGitHub(left.github, right.github);

/**
 * The configuration as a save sends it. `github` is absent only when the host
 * never had a block to begin with, which leaves it alone; a block the user
 * emptied travels as `null`, which removes it, so clearing the section is an
 * explicit instruction rather than something a client can do by omission. The
 * token field's text is the only token that ever leaves the renderer: an empty
 * field sends `null`, which keeps what the host stores rather than clearing it,
 * and only a typed token is sent as itself.
 */
export const configurationInput = (
  configuration: Configuration,
): ConfigurationInput => {
  const { github, ...rest } = configuration;
  if (github === undefined) return { ...rest };
  if (!holdsCredential(github)) return { ...rest, github: null };

  const token = tokenFieldText(github);
  return {
    ...rest,
    github: {
      username: github.username,
      email: github.email,
      token: token === '' ? null : token,
    },
  };
};

/**
 * Patches the github block, creating it on the first field anyone types in, so
 * an untouched section stays absent from the configuration.
 */
export const updateGitHub = (
  configuration: Configuration,
  patch: Partial<GitHubConfiguration>,
): Configuration => ({
  ...configuration,
  github: {
    username: '',
    email: '',
    hasToken: false,
    ...configuration.github,
    ...patch,
  },
});

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
