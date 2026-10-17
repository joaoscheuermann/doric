// The settings bundle's one host adapter (stage 9, design §6.4). Every call the
// settings surfaces made through `window.doric.{config,providers,tools,
// credentials}` is here, over the host contracts the window reaches through the
// bridge. What reached the renderer before is what reaches it now:
//
// - the guards of `app/desktop/doric/src/workspace/validation.ts` (the IPC boundary),
//   with their messages; `desktopConfiguration` is its `configuration()` and
//   keeps its quirk: Tools values, `execution.maxToolResultChars` and
//   `execution.contextCompaction` never reach the host;
// - the checks of the REST routes the old path went through
//   (`bundles/foundation/transport/src/host/routes/*`), with their envelope messages;
// - the response readers of `app/desktop/doric/src/workspace/api.ts`, with
//   'Doric returned an invalid response.' for a shape they refuse.

import {
  type CredentialDescription,
  credentialFieldsSatisfied,
  isContractError,
  type ModelField,
  type ModelKindDescriptor,
  ModelsV1,
  ref,
  SecretsV1,
  type Services,
  ToolsV1,
} from 'bundle/contracts';
import type {
  ConfigReplaceResult,
  Configuration as HostConfiguration,
} from 'runtime/contracts';

import {
  type CatalogModel,
  type Configuration,
  type ConfigurationInput,
  type ContextCompactionConfig,
  type Credential,
  type CredentialCreate,
  type CredentialKind,
  type CredentialUpdate,
  credentialFields,
  credentialKinds,
  type DoricConfiguration,
  type ProviderConfiguration,
  type ProviderField,
  type ProviderFieldKind,
  type ProviderKind,
  type ProviderListId,
  type ProviderModel,
  type ProviderValuesRef,
  type ReasoningEffort,
  reasoningEfforts,
  type ToolCatalogEntry,
  type ToolConfigField,
  type ToolConfigFieldKind,
} from '../domain/config.js';

/**
 * `host-config/v1` (the `/config` pipeline). The ref is declared here by id:
 * `runtime/contracts` is not in a window's import map, so only its types are
 * imported.
 */
export const HostConfigurationV1 = ref<HostConfiguration>('host-config/v1');

/** The failure every settings surface shows: its message is the text on screen. */
export class SettingsApiError extends Error {
  override readonly name = 'SettingsApiError';
}

const fail = (message: string): never => {
  throw new SettingsApiError(message);
};

// The REST client's messages (app/desktop/doric/src/workspace/api.ts).
const unavailableMessage = 'Doric backend is unavailable.';
const invalidResponseMessage = 'Doric returned an invalid response.';
// The transport's final error handler.
const internalMessage = 'The request could not be completed.';

const invalidResponse = (): never => fail(invalidResponseMessage);

/** Bridge failures that mean the host was not reached. */
const unreachable = new Set([
  'unavailable',
  'disconnected',
  'generation_lost',
  'protocol_error',
]);

/**
 * What a host failure the route did not answer itself showed before: a host
 * out of reach is the REST client's "unavailable", an answer the bridge
 * refused is an invalid response, anything else is the final error handler's.
 */
const unexpected = (error: unknown): never => {
  if (error instanceof SettingsApiError) throw error;
  if (isContractError(error)) {
    if (unreachable.has(error.code)) return fail(unavailableMessage);
    if (error.code === 'invalid_output') return invalidResponse();
  }
  return fail(internalMessage);
};

const reach = async <Value>(
  operation: () => Promise<Value>,
): Promise<Value> => {
  try {
    return await operation();
  } catch (error) {
    return unexpected(error);
  }
};

// ---------------------------------------------------------------------------
// Guards of the former IPC boundary (validation.ts), same limits and messages.

const maximumIdentifierLength = 128;
const maximumModelLength = 512;
const maximumUsernameLength = 128;
const maximumEmailLength = 254;
const maximumTokenLength = 512;
const maximumFieldValueLength = 512;

const isPlainRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** A trimmed string within the host's own limit for that field. */
const bounded = (value: unknown, maximum: number): value is string =>
  typeof value === 'string' &&
  value.trim().length > 0 &&
  value.trim().length <= maximum;

const reasoningEffortValues = new Set<string>(reasoningEfforts);

const isReasoningEffort = (value: unknown): value is ReasoningEffort =>
  typeof value === 'string' && reasoningEffortValues.has(value);

/** A token carries no whitespace or control character, so none is trimmed away. */
const tokenPattern = /^[\x21-\x7e]+$/;
const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const invalidConfiguration = (): never => fail('The configuration is invalid.');

const invalidCredential = (): never => fail('The credential is invalid.');

const guardedValues = (value: unknown): Record<string, string> => {
  if (!isPlainRecord(value)) return invalidConfiguration();

  const configuration: Record<string, string> = {};

  for (const [key, entry] of Object.entries(value)) {
    if (
      !bounded(key, maximumIdentifierLength) ||
      !bounded(entry, maximumFieldValueLength)
    ) {
      return invalidConfiguration();
    }

    configuration[key] = entry;
  }

  return configuration;
};

const guardedReasonings = (value: unknown): ReasoningEffort[] | undefined => {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) return invalidConfiguration();

  return value.map((entry) =>
    isReasoningEffort(entry) ? entry : invalidConfiguration(),
  );
};

const guardedModel = (value: unknown): ProviderModel => {
  if (!isPlainRecord(value) || !bounded(value.name, maximumModelLength)) {
    return invalidConfiguration();
  }

  const reasonings = guardedReasonings(value.reasonings);
  const defaultEffort = value.defaultEffort;

  if (
    (defaultEffort !== undefined && !isReasoningEffort(defaultEffort)) ||
    (value.mandatory !== undefined && typeof value.mandatory !== 'boolean')
  ) {
    return invalidConfiguration();
  }

  return {
    name: value.name,
    ...(reasonings === undefined ? {} : { reasonings }),
    ...(defaultEffort === undefined ? {} : { defaultEffort }),
    ...(value.mandatory === undefined ? {} : { mandatory: value.mandatory }),
  };
};

const guardedModels = (value: unknown): ProviderModel[] | undefined => {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) return invalidConfiguration();

  return value.map(guardedModel);
};

const guardedProvider = (value: unknown): ProviderConfiguration => {
  if (
    !isPlainRecord(value) ||
    !bounded(value.id, maximumIdentifierLength) ||
    !bounded(value.kind, maximumIdentifierLength)
  ) {
    return invalidConfiguration();
  }

  const configuration = guardedValues(value.configuration);
  const models = guardedModels(value.models);

  return {
    id: value.id,
    kind: value.kind,
    configuration,
    ...(models === undefined ? {} : { models }),
  };
};

const guardedExecutionModel = (
  value: unknown,
): Configuration['models']['execution'] => {
  if (
    !isPlainRecord(value) ||
    !bounded(value.providerId, maximumIdentifierLength) ||
    !bounded(value.model, maximumModelLength) ||
    (value.effort !== undefined && !isReasoningEffort(value.effort))
  ) {
    return invalidConfiguration();
  }

  return {
    providerId: value.providerId,
    model: value.model,
    ...(value.effort === undefined ? {} : { effort: value.effort }),
  };
};

const guardedMaxTurns = (value: unknown): number => {
  if (!isPlainRecord(value)) return invalidConfiguration();
  const turns = value.maxTurns;
  if (typeof turns !== 'number' || !Number.isSafeInteger(turns) || turns <= 0) {
    return invalidConfiguration();
  }
  return turns;
};

/** A named credential, or nothing when the configuration names none. */
const guardedReference = (value: unknown): string | undefined => {
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

/**
 * The configuration a settings save sends to the host: the former IPC guard,
 * unchanged. It keeps only the providers, the execution model, the turn limit
 * and the two credential references, so the Tools section's values,
 * `execution.maxToolResultChars` and `execution.contextCompaction` never reach
 * the host (a kept quirk), and an empty or `null` reference is sent as none.
 */
export const desktopConfiguration = (value: unknown): ConfigurationInput => {
  if (!isPlainRecord(value) || !Array.isArray(value.providers)) {
    return invalidConfiguration();
  }

  const models = value.models;
  if (!isPlainRecord(models)) return invalidConfiguration();

  const gitCredentialId = guardedReference(value.gitCredentialId);
  const githubCredentialId = guardedReference(value.githubCredentialId);
  return {
    providers: value.providers.map(guardedProvider),
    models: { execution: guardedExecutionModel(models.execution) },
    execution: { maxTurns: guardedMaxTurns(value.execution) },
    ...(gitCredentialId === undefined ? {} : { gitCredentialId }),
    ...(githubCredentialId === undefined ? {} : { githubCredentialId }),
  };
};

/** The values a catalog read names: the kind and its field values. */
const guardedProviderValues = (value: unknown): ProviderValuesRef => {
  if (!isPlainRecord(value) || !bounded(value.kind, maximumIdentifierLength))
    return invalidConfiguration();

  return {
    kind: value.kind,
    configuration: guardedValues(value.configuration),
  };
};

const guardedIdentifier = (value: unknown): string => {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 200 ||
    value.includes('\0')
  ) {
    return fail('The item identifier is invalid.');
  }

  return value;
};

const credentialKindValues: readonly string[] = credentialKinds;

const isCredentialKind = (value: unknown): value is CredentialKind =>
  typeof value === 'string' && credentialKindValues.includes(value);

const guardedSecret = (value: unknown): string => {
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

const optionalField = (value: unknown, maximum: number): string | undefined => {
  if (value === undefined) return undefined;
  if (!bounded(value, maximum)) return invalidConfiguration();
  return value;
};

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

const clearing = (value: unknown, maximum: number): string | null => {
  if (value === undefined || value === null) return null;
  if (value === '') return '';
  if (!bounded(value, maximum)) return invalidCredential();
  return value;
};

const clearingSecret = (value: unknown): string | null => {
  if (value === undefined || value === null) return null;
  if (value === '') return '';
  return guardedSecret(value);
};

const clearingEmail = (value: unknown): string | null => {
  if (value === undefined || value === null) return null;
  if (value === '') return '';
  return emailField(value) ?? null;
};

const guardedCredentialCreate = (value: unknown): CredentialCreate => {
  if (!isPlainRecord(value) || !isCredentialKind(value.kind)) {
    return invalidCredential();
  }
  if (!bounded(value.name, maximumIdentifierLength)) return invalidCredential();

  const username = optionalField(value.username, maximumUsernameLength);
  const email = emailField(value.email);
  const held =
    value.secret === undefined ? undefined : guardedSecret(value.secret);

  return {
    kind: value.kind,
    name: value.name,
    ...(username === undefined ? {} : { username }),
    ...(email === undefined ? {} : { email }),
    ...(held === undefined ? {} : { secret: held }),
  };
};

const guardedCredentialUpdate = (value: unknown): CredentialUpdate => {
  if (!isPlainRecord(value)) return invalidCredential();

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

// ---------------------------------------------------------------------------
// The REST routes' own checks (transport routes), same envelope messages.

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const routeEmailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;

const credentialMismatch = (): never =>
  fail('The credential does not match its kind.');

/** `name`: trimmed, 1..128. */
const routeName = (value: string): string => {
  const trimmed = value.trim();
  if (trimmed.length < 1 || trimmed.length > 128) return credentialMismatch();
  return trimmed;
};

/** `username`: trimmed, 1..128. */
const routeUsername = routeName;

/** `email`: trimmed, at most 256, an address. */
const routeEmail = (value: string): string => {
  const trimmed = value.trim();
  if (trimmed.length > 256 || !routeEmailPattern.test(trimmed))
    return credentialMismatch();
  return trimmed;
};

/** `secret`: 1..512, no line break. */
const routeSecret = (value: string): string => {
  if (value.length < 1 || value.length > 512 || /[\r\n]/u.test(value))
    return credentialMismatch();
  return value;
};

const routeClearing = (
  value: string | null | undefined,
  check: (value: string) => string,
): string | null | undefined =>
  value === undefined || value === null || value === '' ? value : check(value);

/** `POST /credentials`: the kind's fields and nothing else. */
const routeCreate = (input: CredentialCreate): CredentialCreate => {
  const create = {
    kind: input.kind,
    name: routeName(input.name),
    ...(input.username === undefined
      ? {}
      : { username: routeUsername(input.username) }),
    ...(input.email === undefined ? {} : { email: routeEmail(input.email) }),
    ...(input.secret === undefined
      ? {}
      : { secret: routeSecret(input.secret) }),
  };
  if (
    !credentialFieldsSatisfied(
      { required: credentialFields(create.kind), optional: [] },
      create,
    )
  ) {
    return credentialMismatch();
  }
  return create;
};

/** `PATCH /credentials/:id`. */
const routeUpdate = (input: CredentialUpdate): CredentialUpdate => {
  const username = routeClearing(input.username, routeUsername);
  const email = routeClearing(input.email, routeEmail);
  const secret = routeClearing(input.secret, routeSecret);
  return {
    ...(input.kind === undefined ? {} : { kind: input.kind }),
    ...(input.name === undefined ? {} : { name: routeName(input.name) }),
    ...(username === undefined ? {} : { username }),
    ...(email === undefined ? {} : { email }),
    ...(secret === undefined ? {} : { secret }),
  };
};

/** `/credentials/:id`: a UUID. */
const routeCredentialId = (id: string): string =>
  uuidPattern.test(id) ? id : fail('The credential ID is invalid.');

const credentialNotFound = 'The credential was not found.';
const credentialConflict = 'The credential cannot perform this operation.';

/** The failures `writeCredentials` answered for a create or an update. */
const credentialWriteFailure = (error: unknown): never => {
  if (isContractError(error)) {
    switch (error.code) {
      case 'credential_invalid':
        return fail(error.message);
      case 'credential_missing':
        return fail(credentialNotFound);
      case 'credential_kind_immutable':
      case 'credential_name_taken':
        return fail(credentialConflict);
      case 'credential_storage_unavailable':
        return fail('The host cannot store credential secrets.');
    }
  }
  return unexpected(error);
};

/** Whether one declared value is one the field's kind accepts. */
const fieldAccepts = (field: ModelField, value: string): boolean => {
  switch (field.kind) {
    case 'url':
      return value.startsWith('http://') || value.startsWith('https://');
    case 'number':
      return Number.isFinite(Number(value));
    case 'enum':
      return field.options?.includes(value) === true;
    case 'secret':
      return uuidPattern.test(value);
    case 'text':
      return true;
  }
};

/** `POST /providers/models`: the kind's declared fields, nothing else. */
const fieldsAccepted = (
  kind: ModelKindDescriptor,
  configuration: Readonly<Record<string, string>>,
): boolean => {
  const declared = new Map(kind.fields.map((field) => [field.key, field]));

  for (const [key, entry] of Object.entries(configuration)) {
    const field = declared.get(key);

    if (field === undefined || entry.trim() === '') return false;
    if (!fieldAccepts(field, entry)) return false;
  }

  return kind.fields.every(
    (field) => !field.required || configuration[field.key] !== undefined,
  );
};

const invalidProvider = (): never => fail('The provider values are invalid.');

// ---------------------------------------------------------------------------
// Response readers (api.ts), same refusals.

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const valuesFrom = (value: unknown): Record<string, string> => {
  if (!isRecord(value) || Array.isArray(value)) return invalidResponse();

  const entries = Object.entries(value);
  if (entries.some(([, entry]) => typeof entry !== 'string'))
    return invalidResponse();

  return Object.fromEntries(entries as readonly [string, string][]);
};

const stringListFrom = (value: unknown): readonly string[] | undefined => {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string'))
    return invalidResponse();

  return value as readonly string[];
};

const reasoningListFrom = (
  value: unknown,
): readonly ReasoningEffort[] | undefined => {
  const list = stringListFrom(value);
  if (list === undefined) return undefined;
  if (!list.every(isReasoningEffort)) return invalidResponse();

  return list;
};

const providerModelFrom = (value: unknown): ProviderModel => {
  if (!isRecord(value) || typeof value.name !== 'string')
    return invalidResponse();

  const reasonings = reasoningListFrom(value.reasonings);
  const defaultEffort = value.defaultEffort;

  if (
    (defaultEffort !== undefined && !isReasoningEffort(defaultEffort)) ||
    (value.mandatory !== undefined && typeof value.mandatory !== 'boolean')
  ) {
    return invalidResponse();
  }

  return {
    name: value.name,
    ...(reasonings === undefined ? {} : { reasonings }),
    ...(defaultEffort === undefined ? {} : { defaultEffort }),
    ...(value.mandatory === undefined ? {} : { mandatory: value.mandatory }),
  };
};

const providerConfigurationFrom = (value: unknown): ProviderConfiguration => {
  if (
    !isRecord(value) ||
    typeof value.id !== 'string' ||
    typeof value.kind !== 'string'
  ) {
    return invalidResponse();
  }

  const models =
    value.models === undefined
      ? undefined
      : Array.isArray(value.models)
        ? value.models.map(providerModelFrom)
        : invalidResponse();

  return {
    id: value.id,
    kind: value.kind,
    configuration: valuesFrom(value.configuration),
    ...(models === undefined ? {} : { models }),
  };
};

const credentialReferenceFrom = (value: unknown): string | undefined => {
  if (value === undefined) return undefined;
  return typeof value === 'string' ? value : invalidResponse();
};

const toolValuesFrom = (
  value: unknown,
): Readonly<Record<string, Readonly<Record<string, string>>>> | undefined => {
  if (value === undefined) return undefined;
  if (!isRecord(value) || Array.isArray(value)) return invalidResponse();

  const tools: Record<string, Readonly<Record<string, string>>> = {};
  for (const [name, fields] of Object.entries(value))
    tools[name] = valuesFrom(fields);

  return tools;
};

/** Whether an execution answer carries a whole context-compaction policy. */
const isContextCompaction = (
  value: unknown,
): value is ContextCompactionConfig =>
  isPlainRecord(value) &&
  typeof value.enabled === 'boolean' &&
  typeof value.pressurePercent === 'number' &&
  typeof value.tailMinMessages === 'number' &&
  typeof value.summaryMaxChars === 'number' &&
  typeof value.charBudget === 'number';

const configurationFrom = (value: unknown): Configuration => {
  if (
    !isRecord(value) ||
    !Array.isArray(value.providers) ||
    !isRecord(value.models) ||
    !isRecord(value.models.execution) ||
    !isRecord(value.execution) ||
    typeof value.execution.maxTurns !== 'number' ||
    (value.execution.maxToolResultChars !== undefined &&
      typeof value.execution.maxToolResultChars !== 'number') ||
    (value.execution.contextCompaction !== undefined &&
      !isContextCompaction(value.execution.contextCompaction))
  ) {
    return invalidResponse();
  }

  const { providerId, model, effort } = value.models.execution;
  if (
    typeof providerId !== 'string' ||
    typeof model !== 'string' ||
    (effort !== undefined && !isReasoningEffort(effort))
  ) {
    return invalidResponse();
  }

  const gitCredentialId = credentialReferenceFrom(value.gitCredentialId);
  const githubCredentialId = credentialReferenceFrom(value.githubCredentialId);
  const tools = toolValuesFrom(value.tools);
  return {
    providers: value.providers.map(providerConfigurationFrom),
    models: {
      execution: {
        providerId,
        model,
        ...(effort === undefined ? {} : { effort }),
      },
    },
    execution: {
      maxTurns: value.execution.maxTurns,
      ...(value.execution.maxToolResultChars === undefined
        ? {}
        : { maxToolResultChars: value.execution.maxToolResultChars }),
      ...(value.execution.contextCompaction === undefined
        ? {}
        : { contextCompaction: value.execution.contextCompaction }),
    },
    ...(tools === undefined ? {} : { tools }),
    ...(gitCredentialId === undefined ? {} : { gitCredentialId }),
    ...(githubCredentialId === undefined ? {} : { githubCredentialId }),
  };
};

const doricConfigurationFrom = (value: unknown): DoricConfiguration => {
  if (
    !isRecord(value) ||
    typeof value.revision !== 'number' ||
    typeof value.updatedAt !== 'string'
  ) {
    return invalidResponse();
  }

  return {
    configuration: configurationFrom(value.configuration),
    revision: value.revision,
    updatedAt: value.updatedAt,
  };
};

const providerFieldKinds: readonly ProviderFieldKind[] = [
  'text',
  'url',
  'number',
  'enum',
  'secret',
];

const providerLists: readonly ProviderListId[] = ['models', 'reasonings'];

const providerFieldFrom = (value: unknown): ProviderField => {
  if (
    !isRecord(value) ||
    typeof value.key !== 'string' ||
    typeof value.label !== 'string' ||
    !providerFieldKinds.includes(value.kind as ProviderFieldKind) ||
    typeof value.required !== 'boolean' ||
    (value.description !== undefined &&
      typeof value.description !== 'string') ||
    (value.placeholder !== undefined &&
      typeof value.placeholder !== 'string') ||
    (value.advanced !== undefined && typeof value.advanced !== 'boolean')
  ) {
    return invalidResponse();
  }

  const options = stringListFrom(value.options);
  if ((value.kind === 'enum') !== (options !== undefined))
    return invalidResponse();

  return {
    key: value.key,
    label: value.label,
    kind: value.kind as ProviderFieldKind,
    required: value.required,
    ...(value.description === undefined
      ? {}
      : { description: value.description }),
    ...(value.placeholder === undefined
      ? {}
      : { placeholder: value.placeholder }),
    ...(value.advanced === undefined ? {} : { advanced: value.advanced }),
    ...(options === undefined ? {} : { options }),
  };
};

const providerKindFrom = (value: unknown): ProviderKind => {
  if (
    !isRecord(value) ||
    typeof value.id !== 'string' ||
    typeof value.label !== 'string' ||
    typeof value.description !== 'string' ||
    !Array.isArray(value.fields) ||
    !Array.isArray(value.lists) ||
    value.lists.some((list) => !providerLists.includes(list as ProviderListId))
  ) {
    return invalidResponse();
  }

  return {
    id: value.id,
    label: value.label,
    description: value.description,
    fields: value.fields.map(providerFieldFrom),
    lists: value.lists as readonly ProviderListId[],
  };
};

const catalogFrom = (value: unknown): readonly CatalogModel[] => {
  if (!Array.isArray(value)) return invalidResponse();

  return value.map((entry) => {
    if (!isRecord(entry) || typeof entry.id !== 'string')
      return invalidResponse();

    const reasonings = reasoningListFrom(entry.reasonings);
    const parameters = stringListFrom(entry.parameters);

    if (
      reasonings === undefined ||
      parameters === undefined ||
      (entry.name !== undefined && typeof entry.name !== 'string')
    ) {
      return invalidResponse();
    }

    return {
      id: entry.id,
      ...(entry.name === undefined ? {} : { name: entry.name }),
      reasonings,
      parameters,
    };
  });
};

const toolConfigFieldKindValues = new Set<string>([
  'text',
  'url',
  'number',
  'enum',
  'secret',
]);

const toolConfigFieldFrom = (value: unknown): ToolConfigField => {
  if (
    !isRecord(value) ||
    typeof value.key !== 'string' ||
    typeof value.label !== 'string' ||
    !toolConfigFieldKindValues.has(value.kind as string) ||
    typeof value.required !== 'boolean' ||
    (value.description !== undefined &&
      typeof value.description !== 'string') ||
    (value.placeholder !== undefined &&
      typeof value.placeholder !== 'string') ||
    (value.default !== undefined && typeof value.default !== 'string') ||
    (value.advanced !== undefined && typeof value.advanced !== 'boolean')
  ) {
    return invalidResponse();
  }

  const options = stringListFrom(value.options);
  if ((value.kind === 'enum') !== (options !== undefined))
    return invalidResponse();

  return {
    key: value.key,
    label: value.label,
    kind: value.kind as ToolConfigFieldKind,
    required: value.required,
    ...(value.description === undefined
      ? {}
      : { description: value.description }),
    ...(value.placeholder === undefined
      ? {}
      : { placeholder: value.placeholder }),
    ...(value.default === undefined ? {} : { default: value.default }),
    ...(value.advanced === undefined ? {} : { advanced: value.advanced }),
    ...(options === undefined ? {} : { options }),
  };
};

const toolCatalogFrom = (value: unknown): readonly ToolCatalogEntry[] => {
  if (!Array.isArray(value)) return invalidResponse();

  return value.map((entry) => {
    if (
      !isRecord(entry) ||
      typeof entry.name !== 'string' ||
      (entry.description !== undefined &&
        entry.description !== null &&
        typeof entry.description !== 'string') ||
      !Array.isArray(entry.settings)
    ) {
      return invalidResponse();
    }

    return {
      name: entry.name,
      ...(typeof entry.description === 'string'
        ? { description: entry.description }
        : {}),
      settings: entry.settings.map(toolConfigFieldFrom),
    };
  });
};

const credentialFrom = (value: unknown): Credential => {
  if (
    !isRecord(value) ||
    typeof value.id !== 'string' ||
    typeof value.name !== 'string' ||
    !isCredentialKind(value.kind) ||
    typeof value.hasSecret !== 'boolean' ||
    (value.username !== undefined && typeof value.username !== 'string') ||
    (value.email !== undefined && typeof value.email !== 'string')
  ) {
    return invalidResponse();
  }
  return {
    id: value.id,
    kind: value.kind,
    name: value.name,
    ...(value.username === undefined ? {} : { username: value.username }),
    ...(value.email === undefined ? {} : { email: value.email }),
    hasSecret: value.hasSecret,
  };
};

// ---------------------------------------------------------------------------

/** What the settings surfaces call; the shape `window.doric` had for them. */
export interface SettingsApi {
  readonly config: {
    get(): Promise<DoricConfiguration>;
    update(configuration: ConfigurationInput): Promise<DoricConfiguration>;
  };
  readonly tools: {
    catalog(): Promise<readonly ToolCatalogEntry[]>;
  };
  readonly providers: {
    kinds(): Promise<readonly ProviderKind[]>;
    models(values: ProviderValuesRef): Promise<readonly CatalogModel[]>;
  };
  readonly credentials: {
    list(): Promise<readonly Credential[]>;
    create(input: CredentialCreate): Promise<Credential>;
    update(id: string, input: CredentialUpdate): Promise<Credential>;
    remove(id: string): Promise<void>;
  };
}

const replaced = (result: ConfigReplaceResult): DoricConfiguration => {
  if (result.status === 'replaced')
    return doricConfigurationFrom(result.config);
  if (result.status === 'invalid') return fail(result.message);
  return fail('The Doric configuration could not be activated.');
};

/** The adapter over one bundle activation's services. */
export const createSettingsApi = (services: Services): SettingsApi => ({
  config: {
    get: async () =>
      doricConfigurationFrom(
        await reach(() => services.use(HostConfigurationV1).current()),
      ),
    update: async (configuration) => {
      const input = desktopConfiguration(configuration);
      let result: ConfigReplaceResult;
      try {
        result = await services.use(HostConfigurationV1).replace(input);
      } catch (error) {
        // The route answered any failure of the replacement as a rejection;
        // a host out of reach never got that far.
        if (isContractError(error) && unreachable.has(error.code))
          return fail(unavailableMessage);
        return fail('The Doric configuration could not be activated.');
      }
      return replaced(result);
    },
  },
  tools: {
    catalog: async () =>
      toolCatalogFrom(await reach(() => services.use(ToolsV1).catalog())),
  },
  providers: {
    kinds: async () => {
      const kinds = await reach(() => services.use(ModelsV1).kinds());
      if (!Array.isArray(kinds)) return invalidResponse();
      return kinds.map(providerKindFrom);
    },
    models: async (values) => {
      const guarded = guardedProviderValues(values);
      const kindId = guarded.kind.trim();
      if (kindId.length < 1 || kindId.length > 128) return invalidProvider();
      const models = services.use(ModelsV1);
      const kind = await reach(() => models.kind(kindId));
      if (kind === undefined || !fieldsAccepted(kind, guarded.configuration))
        return invalidProvider();
      const read = await reach(() =>
        models.catalog({ kind: kind.id, configuration: guarded.configuration }),
      );
      if (read.status !== 'read')
        return fail('The provider model catalog could not be read.');
      return catalogFrom(read.models);
    },
  },
  credentials: {
    list: async () => {
      const listed = await reach(() => services.use(SecretsV1).list());
      if (!Array.isArray(listed)) return invalidResponse();
      return listed.map(credentialFrom);
    },
    create: async (input) => {
      const create = routeCreate(guardedCredentialCreate(input));
      let created: CredentialDescription;
      try {
        created = await services.use(SecretsV1).create(create);
      } catch (error) {
        return credentialWriteFailure(error);
      }
      return credentialFrom(created);
    },
    update: async (id, input) => {
      const credentialId = routeCredentialId(guardedIdentifier(id));
      const update = routeUpdate(guardedCredentialUpdate(input));
      let updated: CredentialDescription;
      try {
        updated = await services
          .use(SecretsV1)
          .update({ id: credentialId }, update);
      } catch (error) {
        return credentialWriteFailure(error);
      }
      return credentialFrom(updated);
    },
    remove: async (id) => {
      const credentialId = routeCredentialId(guardedIdentifier(id));
      const result = await reach(() =>
        services.use(SecretsV1).delete({ id: credentialId }),
      );
      if (result === 'missing') return fail(credentialNotFound);
      if (result === 'referenced') return fail(credentialConflict);
    },
  },
});

let active: SettingsApi | undefined;

/** Binds the module adapter to the bundle's activation services (D9-17). */
export const initSettingsApi = (services: Services | undefined): void => {
  active = services === undefined ? undefined : createSettingsApi(services);
};

/** The adapter the hooks call; the bundle is active while its UI exists. */
export const api = (): SettingsApi => {
  if (active === undefined) {
    throw new SettingsApiError('Doric backend is unavailable.');
  }
  return active;
};
