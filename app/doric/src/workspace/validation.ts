import {
  type Configuration,
  type ConfigurationInput,
  type CredentialCreate,
  type CredentialKind,
  type CredentialUpdate,
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
const maximumFieldValueLength = 512;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

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

/** The keys a credential body may carry; the renderer sends nothing else. */

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

/**
 * The renderer may send IPC only from an exact URL the main process itself
 * loaded. The allow-list is the whole rule: a sender is accepted when its URL is
 * one of those strings, and never by prefix, origin or wildcard.
 */
export const senderIsAllowed = (
  senderUrl: string | undefined,
  allowedUrls: readonly string[],
): boolean => senderUrl !== undefined && allowedUrls.includes(senderUrl);

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
    !bounded(value.kind, maximumIdentifierLength) ||
    !isRecord(value.configuration) ||
    Array.isArray(value.configuration)
  ) {
    return invalidConfiguration();
  }

  // The catalog is the host's, so this reads any field key and any value: what it
  // refuses is a value the host could never carry, not one it has not seen.
  const configuration: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value.configuration)) {
    if (
      !bounded(key, maximumIdentifierLength) ||
      !bounded(entry, maximumFieldValueLength)
    ) {
      return invalidConfiguration();
    }

    configuration[key] = entry;
  }

  const models = modelList(value.models);
  const reasonings = reasoningList(value.reasonings);

  return {
    id: value.id,
    kind: value.kind,
    configuration,
    ...(models === undefined ? {} : { models }),
    ...(reasonings === undefined ? {} : { reasonings }),
  };
};

/** The models a provider offers, or nothing when its kind keeps none. */
const modelList = (value: unknown): string[] | undefined => {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) return invalidConfiguration();

  return value.map((entry) =>
    bounded(entry, maximumModelLength) ? entry : invalidConfiguration(),
  );
};

/** The efforts a provider accepts; a name llms does not know is not one. */
const reasoningList = (value: unknown): ReasoningEffort[] | undefined => {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) return invalidConfiguration();

  return value.map((entry) =>
    isReasoningEffort(entry) ? entry : invalidConfiguration(),
  );
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
 * The credential kinds this boundary accepts, spelled out rather than imported
 * so a new kind cannot reach the host through a shared constant without a
 * deliberate edit here too.
 */
const credentialKindValues = ['API_TOKEN', 'USERNAME_PASSWORD', 'GIT'] as const;

const isCredentialKind = (value: unknown): value is CredentialKind =>
  typeof value === 'string' &&
  (credentialKindValues as readonly string[]).includes(value);

/**
 * A stored secret as this boundary reads it: bounded, free of line breaks, and
 * never trimmed. A credential carrying whitespace is refused rather than
altered.
 */
const secret = (value: unknown): string => {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > maximumTokenLength ||
    !tokenPattern.test(value)
  ) {
    return invalidConfiguration();
  }
  return value;
};

/** One of the kind's optional string fields, when the credential carries it. */
const optionalField = (value: unknown, maximum: number): string | undefined => {
  if (value === undefined) return undefined;
  if (!bounded(value, maximum)) return invalidConfiguration();
  return value;
};

/**
 * Guards a credential create. The kind's own field set is the host service's
 * rule and it re-checks the stored row, so this refuses only a shape the host
 * could never accept; every refusal is one sentence that never names a value, so
 * a submitted secret cannot reach an error string, a log line, or a render.
 */
export const credentialCreate = (value: unknown): CredentialCreate => {
  if (!isRecord(value) || !isCredentialKind(value.kind)) {
    return invalidCredential();
  }
  if (!bounded(value.name, maximumIdentifierLength)) return invalidCredential();

  const username = optionalField(value.username, maximumUsernameLength);
  const email = emailField(value.email);
  const held = value.secret === undefined ? undefined : secret(value.secret);

  return {
    kind: value.kind,
    name: value.name,
    ...(username === undefined ? {} : { username }),
    ...(email === undefined ? {} : { email }),
    ...(held === undefined ? {} : { secret: held }),
  };
};

/**
 * Guards a credential patch. Every field follows one rule — absent or `null`
 * keeps what is stored, `''` clears it, and a value sets it — so a secret is
 * never cleared by a caller that did not mean to. A rejected change to `kind`
 * travels as `undefined` and is the host service's answer, not a shape error.
 */
export const credentialUpdate = (value: unknown): CredentialUpdate => {
  if (!isRecord(value)) return invalidCredential();

  const kind = value.kind;
  if (kind !== undefined && !isCredentialKind(kind)) return invalidCredential();

  const name = value.name;
  if (name !== undefined && !bounded(name, maximumIdentifierLength)) {
    return invalidCredential();
  }

  return {
    ...(kind === undefined ? {} : { kind }),
    ...(name === undefined ? {} : { name }),
    username: clearing(value.username, maximumUsernameLength),
    email: clearingEmail(value.email),
    secret: clearingSecret(value.secret),
  };
};

/** `''` clears a stored field, `null` or an absent key keeps it. */
const clearing = (value: unknown, maximum: number): string | null => {
  if (value === undefined || value === null) return null;
  if (value === '') return '';
  if (!bounded(value, maximum)) return invalidCredential();
  return value;
};

const clearingSecret = (value: unknown): string | null => {
  if (value === undefined || value === null) return null;
  if (value === '') return '';
  return secret(value);
};

/** A credential's email field, which is an address when present. */
const emailField = (value: unknown): string | undefined => {
  if (value === undefined) return undefined;
  if (
    typeof value !== 'string' ||
    value.trim().length === 0 ||
    value.trim().length > maximumEmailLength ||
    !emailPattern.test(value.trim())
  ) {
    return invalidCredential();
  }
  return value;
};

/** `''` clears a stored field, `null` or an absent key keeps it. */
const clearingEmail = (value: unknown): string | null => {
  if (value === undefined || value === null) return null;
  if (value === '') return '';
  return emailField(value) ?? null;
};

/** One refusal for every credential shape this boundary cannot accept. */
const invalidCredential = (): never => {
  throw new WorkspaceError('The credential is invalid.');
};

/**
 * Guards the renderer's configuration payload, the only way a Settings surface
 * reaches the host. Uniqueness and cross-references stay the host's job, so this
 * boundary only refuses a shape the host could never accept. No secret travels
 * this way any more: the configuration names credentials by id.
 */
export const configuration = (value: unknown): ConfigurationInput => {
  if (!isRecord(value) || !Array.isArray(value.providers)) {
    return invalidConfiguration();
  }

  const gitCredentialId = reference(value.gitCredentialId);
  const githubCredentialId = reference(value.githubCredentialId);
  return {
    providers: value.providers.map(provider),
    models: models(value.models),
    execution: { maxTurns: maximumTurns(value.execution) },
    ...(gitCredentialId === undefined ? {} : { gitCredentialId }),
    ...(githubCredentialId === undefined ? {} : { githubCredentialId }),
  };
};

/** A named credential, or nothing when the configuration names none. */
const reference = (value: unknown): string | undefined => {
  if (value === undefined || value === null || value === '') return undefined;
  if (
    typeof value !== 'string' ||
    value.length > maximumIdentifierLength ||
    value.includes('\0')
  ) {
    return invalidConfiguration();
  }
  return value;
};
