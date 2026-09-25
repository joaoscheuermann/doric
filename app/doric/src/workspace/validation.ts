import {
  type Configuration,
  type ConfigurationInput,
  type GitHubInput,
  type ReasoningEffort,
  reasoningEfforts,
  WorkspaceError,
} from './api';

const maximumNameLength = 80;
const maximumPathLength = 4096;
const maximumIdentifierLength = 128;
const maximumModelLength = 512;
const maximumUsernameLength = 128;
const maximumEmailLength = 254;
const maximumTokenLength = 512;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const nonEmpty = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0;

/** A trimmed string within the host's own limit for that field. */
const bounded = (value: unknown, maximum: number): value is string =>
  typeof value === 'string' &&
  value.trim().length > 0 &&
  value.trim().length <= maximum;

const isReasoningEffort = (value: unknown): value is ReasoningEffort =>
  typeof value === 'string' &&
  (reasoningEfforts as readonly string[]).includes(value);

/** A token carries no whitespace or control character, so none is trimmed away. */
const tokenPattern = /^[\x21-\x7e]+$/;
const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** The keys a GitHub block may carry; the renderer sends nothing else. */
const githubKeys = ['username', 'email', 'token'] as const;

const invalidConfiguration = (): never => {
  throw new WorkspaceError('The configuration is invalid.');
};

/** The palette the host accepts; a client only ever names one of these. */
const projectColors = [
  'red',
  'orange',
  'amber',
  'green',
  'teal',
  'blue',
  'violet',
  'pink',
] as const;

export const senderIsAllowed = (
  senderUrl: string | undefined,
  rendererUrl: string,
): boolean => senderUrl === rendererUrl;

export const name = (value: unknown): string => {
  if (typeof value !== 'string' || value.includes('\0')) {
    throw new WorkspaceError('Enter a valid name before continuing.');
  }

  const trimmed = value.trim();
  if (trimmed.length === 0 || Array.from(trimmed).length > maximumNameLength) {
    throw new WorkspaceError('Enter a name between 1 and 80 characters.');
  }

  return trimmed;
};

export const identifier = (value: unknown): string => {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 200 ||
    value.includes('\0')
  ) {
    throw new WorkspaceError('The item identifier is invalid.');
  }

  return value;
};

/** A palette color, or undefined when the color is being cleared. */
export const projectColor = (value: unknown): string | undefined => {
  if (value === undefined || value === null) return undefined;
  if (
    typeof value !== 'string' ||
    !(projectColors as readonly string[]).includes(value)
  ) {
    throw new WorkspaceError('Choose a color from the palette.');
  }
  return value;
};

export const prompt = (value: unknown): string => {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new WorkspaceError('Enter a prompt before continuing.');
  }
  return value;
};

/**
 * A workspace-relative path. `undefined` and `''` both name the workspace root
 * and normalize to `''`, because a call without a path and a call for the root
 * mean the same thing. The renderer is untrusted, so this is the first end of
 * the two-end confinement; the host is the second.
 */
export const relativePath = (value: unknown): string => {
  if (value === undefined) return '';
  if (
    typeof value !== 'string' ||
    value.includes('\0') ||
    value.length > maximumPathLength ||
    value.startsWith('/') ||
    value.split('/').includes('..')
  ) {
    throw new WorkspaceError('The workspace path is invalid.');
  }
  return value;
};

export const sequence = (value: unknown): number => {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new WorkspaceError('The event cursor is invalid.');
  }
  return value;
};

const provider = (value: unknown): Configuration['providers'][number] => {
  if (
    !isRecord(value) ||
    !bounded(value.id, maximumIdentifierLength) ||
    !nonEmpty(value.baseUrl) ||
    !nonEmpty(value.apiKeyEnv)
  ) {
    return invalidConfiguration();
  }
  return { id: value.id, baseUrl: value.baseUrl, apiKeyEnv: value.apiKeyEnv };
};

const executionModel = (
  value: unknown,
): Configuration['models']['execution'] => {
  if (
    !isRecord(value) ||
    !bounded(value.providerId, maximumIdentifierLength) ||
    !bounded(value.model, maximumModelLength) ||
    !isReasoningEffort(value.effort)
  ) {
    return invalidConfiguration();
  }
  return {
    providerId: value.providerId,
    model: value.model,
    effort: value.effort,
  };
};

const maximumTurns = (value: unknown): number => {
  if (!isRecord(value)) return invalidConfiguration();
  const turns = value.maxTurns;
  if (typeof turns !== 'number' || !Number.isSafeInteger(turns) || turns <= 0) {
    return invalidConfiguration();
  }
  return turns;
};

const models = (value: unknown): Configuration['models'] => {
  if (!isRecord(value)) return invalidConfiguration();
  return { execution: executionModel(value.execution) };
};

/**
 * The GitHub block: the one place a credential crosses this boundary. Every
 * refusal is the same sentence and no message ever names the value it refused,
 * so a submitted token cannot reach an error string, a log line or a renderer
 * render.
 */
const github = (value: unknown): GitHubInput => {
  if (!isRecord(value)) return invalidConfiguration();
  for (const key of Object.keys(value)) {
    if (!(githubKeys as readonly string[]).includes(key)) {
      return invalidConfiguration();
    }
  }

  if (!bounded(value.username, maximumUsernameLength)) {
    return invalidConfiguration();
  }

  const email = value.email;
  if (
    typeof email !== 'string' ||
    email.trim().length === 0 ||
    email.trim().length > maximumEmailLength ||
    !emailPattern.test(email.trim())
  ) {
    return invalidConfiguration();
  }

  return {
    username: value.username,
    email,
    token: submittedToken(value.token),
  };
};

/**
 * The token as the host reads it: absent or null keeps the stored one, `''`
 * clears it and a non-empty string replaces it. A credential is never trimmed,
 * so a token carrying whitespace is refused rather than altered.
 */
const submittedToken = (value: unknown): string | null => {
  if (value === undefined || value === null) return null;
  if (
    typeof value !== 'string' ||
    value.length > maximumTokenLength ||
    (value !== '' && !tokenPattern.test(value))
  ) {
    return invalidConfiguration();
  }
  return value;
};

/**
 * Guards the renderer's configuration payload, the only way a Settings surface
 * reaches the host. Uniqueness and cross-references stay the host's job, so this
 * boundary only refuses a shape the host could never accept — and inside the
 * GitHub block, which carries the one credential that travels this way, every
 * key is known and every value bounded.
 */
export const configuration = (value: unknown): ConfigurationInput => {
  if (!isRecord(value) || !Array.isArray(value.providers)) {
    return invalidConfiguration();
  }

  const githubBlock = value.github;
  return {
    providers: value.providers.map(provider),
    models: models(value.models),
    execution: { maxTurns: maximumTurns(value.execution) },
    // Absent leaves the stored block alone; `null` removes it; an object sets it.
    ...(githubBlock === undefined
      ? {}
      : { github: githubBlock === null ? null : github(githubBlock) }),
  };
};
