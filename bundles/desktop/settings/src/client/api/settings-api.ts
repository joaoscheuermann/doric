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
//
// From slice S65c the host contracts are their generated Connect clients —
// `HostConfigService`, `ModelsService`, `ToolsService` and `SecretsService` —
// each answer read back as today's JSON (`runtime/contracts`' `decode`) and
// each failure as its Doric error (`fromConnectError`); `doric.browser/v1`
// and `workspace.dashboard/v1` stay on the envelope.

import {
  type ClientServices,
  credentialFieldsSatisfied,
  type Disposable,
  DoricBrowserV1,
  fromConnectError,
  isContractError,
  MODEL_ICON_MAX_LENGTH,
  type ModelField,
  type ModelIconAnswers,
  type ModelKindDescriptor,
  modelsMethods,
  type Services,
} from 'bundle/contracts';
import { ModelKindDescriptorSchema } from 'bundle/contracts/gen/doric/models/provider/v1/provider_pb.js';
import {
  CatalogResponseSchema,
  IconsRequestSchema,
  IconsResponseSchema,
  KindsResponseSchema,
  ModelsService,
} from 'bundle/contracts/gen/doric/models/v1/models_pb.js';
import {
  CreateRequestSchema,
  CreateResponseSchema,
  CredentialUpdateSchema,
  ListResponseSchema,
  SecretsService,
  UpdateResponseSchema,
} from 'bundle/contracts/gen/doric/secrets/v1/secrets_pb.js';
import {
  CatalogResponseSchema as ToolCatalogResponseSchema,
  ToolsService,
} from 'bundle/contracts/gen/doric/tools/v1/tools_pb.js';
import { ClientError } from 'desktop/reads';
import {
  CurrentResponseSchema,
  HostConfigService,
  ReplaceRequestSchema,
  ReplaceResponseSchema,
} from 'host-config/contracts/gen/doric/host_config/v1/host_config_pb.js';
import { decode, encode } from 'runtime/contracts';

import {
  type AutoArchive,
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
  type Profile,
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
import type { IconRequest } from '../domain/model-icons.js';
import { WorkspaceDashboardV1 } from './navigation-refs.js';

/**
 * The rejection of every settings adapter call: a `ClientError` whose
 * `message` is the text the surface showed before this change, unchanged, and
 * whose `code` names the outcome (§6.4): the host's contract error code
 * (other than `internal`), `internal`, `invalid_input`, `invalid_output`,
 * `not_found` or `conflict`. `cause` holds the error the host answered, when
 * there is one and its code is not `internal` (D11); `retryable` is set only
 * where a repeat is known to fail the same way (`api()` with no bridge).
 *
 * Constructed as `new SettingsApiError(code, message, options?)`, the
 * `ClientError` constructor; it never throws. `name` is always
 * `'SettingsApiError'`. Readers use `errorInfo`, which reads its fields, not
 * `instanceof`.
 */
export class SettingsApiError extends ClientError {
  override readonly name = 'SettingsApiError';
}

/**
 * Throws a `SettingsApiError` with `code` and `message` as given, and with
 * `cause` as its `cause` when `cause` is not `undefined`. Never returns.
 */
const fail = (code: string, message: string, cause?: unknown): never => {
  throw new SettingsApiError(
    code,
    message,
    cause === undefined ? undefined : { cause },
  );
};

// The REST client's messages (app/desktop/doric/src/workspace/api.ts).
const unavailableMessage = 'Doric backend is unavailable.';
const invalidResponseMessage = 'Doric returned an invalid response.';
// The transport's final error handler.
const internalMessage = 'The request could not be completed.';

const invalidResponse = (): never =>
  fail('invalid_output', invalidResponseMessage);

/**
 * Fails with `message` and the code of a host failure (§6.4): a contract
 * error's own code with that error as cause, unless its code is `internal`;
 * `internal` with no cause for anything else.
 */
const hostFailure = (error: unknown, message: string): never =>
  isContractError(error) && error.code !== 'internal'
    ? fail(error.code, message, error)
    : fail('internal', message);

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
    if (unreachable.has(error.code))
      return hostFailure(error, unavailableMessage);
    if (error.code === 'invalid_output')
      return hostFailure(error, invalidResponseMessage);
  }
  return hostFailure(error, internalMessage);
};

/** The failure a Connect client throws (`fromConnectError` reads it). */
type ConnectFailure = Parameters<typeof fromConnectError>[0];

/**
 * Whether `error` is a Connect client's failure. Read by shape, as Connect's
 * own `instanceof` does: settings declares no `@connectrpc/connect`.
 */
const isConnectFailure = (error: unknown): error is ConnectFailure =>
  error instanceof Error &&
  error.name === 'ConnectError' &&
  typeof (error as { readonly findDetails?: unknown }).findDetails ===
    'function';

/** A Connect failure as its Doric error (`fromConnectError`); any other error unchanged. */
const contractError = (error: unknown): unknown =>
  isConnectFailure(error) ? fromConnectError(error) : error;

const reach = async <Value>(
  operation: () => Promise<Value>,
): Promise<Value> => {
  try {
    return await operation();
  } catch (error) {
    return unexpected(contractError(error));
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

const invalidConfiguration = (): never =>
  fail('invalid_input', 'The configuration is invalid.');

const invalidCredential = (): never =>
  fail('invalid_input', 'The credential is invalid.');

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
 * The profile a save sends: none for `undefined` or `null`. A value that is not
 * a plain record, or has a `name`/`timezone` that is present but not a string,
 * fails with `invalidConfiguration()`. Only `name` and `timezone` are kept,
 * each only when present, and a profile left with no field becomes none.
 * Contents are not checked here; the host does that and answers `invalid`.
 */
const guardedProfile = (value: unknown): Profile | undefined => {
  if (value === undefined || value === null) return undefined;
  if (
    !isPlainRecord(value) ||
    (value.name !== undefined && typeof value.name !== 'string') ||
    (value.timezone !== undefined && typeof value.timezone !== 'string')
  ) {
    return invalidConfiguration();
  }
  const { name, timezone } = value;
  if (name === undefined && timezone === undefined) return undefined;
  return {
    ...(name === undefined ? {} : { name }),
    ...(timezone === undefined ? {} : { timezone }),
  };
};

const mainThreadsAfterChoices: readonly unknown[] = [
  '1d',
  '7d',
  '30d',
  'never',
];

/**
 * The known keys of a `threads` value, or `fail()` for one no host accepts: a
 * plain record whose `autoArchive`, when present, is a plain record with
 * `agentThreads` absent or boolean and `mainThreadsAfter` absent or a known
 * choice.
 */
const knownThreads = (
  value: unknown,
  fail: () => never,
): NonNullable<Configuration['threads']> => {
  if (!isPlainRecord(value)) return fail();
  const { autoArchive } = value;
  if (autoArchive === undefined) return {};
  if (
    !isPlainRecord(autoArchive) ||
    (autoArchive.agentThreads !== undefined &&
      typeof autoArchive.agentThreads !== 'boolean') ||
    (autoArchive.mainThreadsAfter !== undefined &&
      !mainThreadsAfterChoices.includes(autoArchive.mainThreadsAfter))
  ) {
    return fail();
  }
  const { agentThreads, mainThreadsAfter } = autoArchive as AutoArchive;
  return {
    autoArchive: {
      ...(agentThreads === undefined ? {} : { agentThreads }),
      ...(mainThreadsAfter === undefined ? {} : { mainThreadsAfter }),
    },
  };
};

/**
 * The `threads` a save sends: none for `undefined` or `null`, its known keys
 * otherwise, and `invalidConfiguration()` for a value no host accepts.
 */
const guardedThreads = (
  value: unknown,
): Configuration['threads'] | undefined =>
  value === undefined || value === null
    ? undefined
    : knownThreads(value, invalidConfiguration);

/**
 * The configuration a settings save sends to the host: the former IPC guard,
 * unchanged but for the profile. It keeps only the providers, the execution
 * model, the turn limit, the two credential references and the profile, so the
 * Tools section's values, `execution.maxToolResultChars` and
 * `execution.contextCompaction` never reach the host (a kept quirk), and an
 * empty or `null` reference is sent as none. The profile reaches the host as
 * the draft holds it, without `profile` when the draft has none.
 */
export const desktopConfiguration = (value: unknown): ConfigurationInput => {
  if (!isPlainRecord(value) || !Array.isArray(value.providers)) {
    return invalidConfiguration();
  }

  const models = value.models;
  if (!isPlainRecord(models)) return invalidConfiguration();

  const gitCredentialId = guardedReference(value.gitCredentialId);
  const githubCredentialId = guardedReference(value.githubCredentialId);
  const profile = guardedProfile(value.profile);
  const threads = guardedThreads(value.threads);
  return {
    providers: value.providers.map(guardedProvider),
    models: { execution: guardedExecutionModel(models.execution) },
    execution: { maxTurns: guardedMaxTurns(value.execution) },
    ...(gitCredentialId === undefined ? {} : { gitCredentialId }),
    ...(githubCredentialId === undefined ? {} : { githubCredentialId }),
    ...(profile === undefined ? {} : { profile }),
    ...(threads === undefined ? {} : { threads }),
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
    return fail('invalid_input', 'The item identifier is invalid.');
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
  fail('invalid_input', 'The credential does not match its kind.');

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
  uuidPattern.test(id)
    ? id
    : fail('invalid_input', 'The credential ID is invalid.');

const credentialNotFound = 'The credential was not found.';
const credentialConflict = 'The credential cannot perform this operation.';

/** The failures `writeCredentials` answered for a create or an update. */
const credentialWriteFailure = (failure: unknown): never => {
  const error = contractError(failure);
  if (isContractError(error)) {
    switch (error.code) {
      case 'credential_invalid':
        return fail(error.code, error.message, error);
      case 'credential_missing':
        return fail(error.code, credentialNotFound, error);
      case 'credential_kind_immutable':
      case 'credential_name_taken':
        return fail(error.code, credentialConflict, error);
      case 'credential_storage_unavailable':
        return fail(
          error.code,
          'The host cannot store credential secrets.',
          error,
        );
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

const invalidProvider = (): never =>
  fail('invalid_input', 'The provider values are invalid.');

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

/**
 * The profile a host answer carries: none when it is absent. Anything that is not
 * a plain record of optional string `name`/`timezone` fails with
 * `invalidResponse()`. Only those two fields are kept.
 */
const profileFrom = (value: unknown): Profile | undefined => {
  if (value === undefined) return undefined;
  if (
    !isPlainRecord(value) ||
    (value.name !== undefined && typeof value.name !== 'string') ||
    (value.timezone !== undefined && typeof value.timezone !== 'string')
  ) {
    return invalidResponse();
  }
  const { name, timezone } = value;
  return {
    ...(name === undefined ? {} : { name }),
    ...(timezone === undefined ? {} : { timezone }),
  };
};

/**
 * The `threads` a host answer carries: none when it is absent, its known keys
 * otherwise, and `invalidResponse()` for a value outside the contract.
 */
const threadsFrom = (value: unknown): Configuration['threads'] | undefined =>
  value === undefined ? undefined : knownThreads(value, invalidResponse);

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
  const profile = profileFrom(value.profile);
  const threads = threadsFrom(value.threads);
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
    ...(profile === undefined ? {} : { profile }),
    ...(threads === undefined ? {} : { threads }),
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

/**
 * A kind's site when its URL parses with the `https:` scheme and its label is a
 * non-empty string; none otherwise. A malformed site never fails the kind.
 */
const siteFrom = (value: unknown): ProviderKind['site'] => {
  if (
    !isRecord(value) ||
    typeof value.url !== 'string' ||
    typeof value.label !== 'string' ||
    value.label === '' ||
    !URL.canParse(value.url) ||
    new URL(value.url).protocol !== 'https:'
  ) {
    return undefined;
  }

  return { url: value.url, label: value.label };
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

  const site = siteFrom(value.site);

  return {
    id: value.id,
    label: value.label,
    description: value.description,
    fields: value.fields.map(providerFieldFrom),
    lists: value.lists as readonly ProviderListId[],
    ...(value.modelsFromCatalog === true ? { modelsFromCatalog: true } : {}),
    ...(site === undefined ? {} : { site }),
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

    // The default is kept only when it is an effort the model lists, the
    // rule the host's configuration applies to a stored model.
    const defaultEffort =
      typeof entry.defaultEffort === 'string' &&
      reasonings.includes(entry.defaultEffort as ReasoningEffort)
        ? (entry.defaultEffort as ReasoningEffort)
        : undefined;

    return {
      id: entry.id,
      ...(entry.name === undefined ? {} : { name: entry.name }),
      reasonings,
      parameters,
      ...(defaultEffort === undefined ? {} : { defaultEffort }),
      ...(entry.mandatory === true ? { mandatory: true } : {}),
    };
  });
};

/**
 * The host's icon answers to `requests`, or "Doric returned an invalid
 * response." when the value is not an object; when `svgs` is not a record of
 * strings, each starting with `<svg` and at most `MODEL_ICON_MAX_LENGTH` long;
 * when `answers` has another length than `requests`, or an answer's `models`
 * another length than its request's; or when a name it uses is not an own key
 * of `svgs`.
 */
const iconAnswersFrom = (
  value: unknown,
  requests: readonly IconRequest[],
): ModelIconAnswers => {
  if (!isRecord(value) || Array.isArray(value)) return invalidResponse();
  const { svgs, answers } = value;
  if (!isRecord(svgs) || Array.isArray(svgs)) return invalidResponse();
  const svgsValid = Object.values(svgs).every(
    (svg) =>
      typeof svg === 'string' &&
      svg.startsWith('<svg') &&
      svg.length <= MODEL_ICON_MAX_LENGTH,
  );
  if (!svgsValid) return invalidResponse();
  if (!Array.isArray(answers) || answers.length !== requests.length)
    return invalidResponse();

  const named = (name: unknown): boolean =>
    typeof name === 'string' && Object.hasOwn(svgs, name);

  const read = answers.map((answer: unknown, index) => {
    const request = requests[index];
    if (
      request === undefined ||
      !isRecord(answer) ||
      !Array.isArray(answer.models) ||
      answer.models.length !== request.models.length ||
      (answer.provider !== undefined && !named(answer.provider)) ||
      !answer.models.every((model: unknown) => model === null || named(model))
    ) {
      return invalidResponse();
    }
    return {
      ...(answer.provider === undefined
        ? {}
        : { provider: answer.provider as string }),
      models: answer.models as (string | null)[],
    };
  });

  return { svgs: svgs as Record<string, string>, answers: read };
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

/**
 * Whether a listed entry is a credential of a kind this window does not
 * manage: a record whose `kind` is a string outside `credentialKinds`, such as
 * the MCP bundle's `MCP_TOKEN`. Such entries are left out of the list whatever
 * else they carry, since the window never reads them. Never fails. Answers
 * `false` for an entry of a managed kind, a non-string kind, or a non-record,
 * so those still go through `credentialFrom` and its strict checks.
 */
const isUnmanagedCredential = (value: unknown): boolean =>
  isRecord(value) &&
  typeof value.kind === 'string' &&
  !isCredentialKind(value.kind);

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
    /**
     * Every request's icons, in one host call and request order; the provider
     * id never leaves the renderer. Each answer lists as many models as its
     * request, and every name it uses is a key of `svgs`. An empty list
     * answers `{ svgs: {}, answers: [] }` without a host call. Fails with a
     * `SettingsApiError`: "Doric returned an invalid response." for an answer
     * that breaks these rules, and the adapter's usual messages when the host
     * is out of reach or refuses the call.
     */
    icons(requests: readonly IconRequest[]): Promise<ModelIconAnswers>;
  };
  readonly credentials: {
    /**
     * The stored credentials of the kinds this window manages
     * (`credentialKinds`), in the host's order. Credentials of kinds other
     * bundles store are left out, so they never fail the list. Fails with a
     * `SettingsApiError`: "Doric returned an invalid response." for an answer
     * that is not a list or that holds a malformed entry of a managed kind,
     * and the adapter's usual messages when the host is out of reach or
     * refuses the call.
     */
    list(): Promise<readonly Credential[]>;
    create(input: CredentialCreate): Promise<Credential>;
    update(id: string, input: CredentialUpdate): Promise<Credential>;
    remove(id: string): Promise<void>;
  };
  /**
   * The /projects dashboard's shown page (`workspace.dashboard/v1`, optional).
   * Without a provider no page is shown: `active` is `undefined`, `show` does
   * nothing, and a subscription never hears a change.
   */
  readonly dashboard: {
    active(): string | undefined;
    show(id: string): void;
    subscribe(listener: () => void): Disposable;
  };
  /** Opens an https page in the system browser, outside the app. */
  openBrowser(url: string): Promise<void>;
}

/**
 * `Icons`' answer as today's: an icon-less model travels as `""`, as the
 * core sends it, and reads as `null`.
 */
const iconsOf = (value: unknown): unknown => {
  const answers = fieldOf(value, 'answers');
  if (!isRecord(value) || !Array.isArray(answers)) return value;
  return {
    ...value,
    answers: answers.map((answer: unknown) => {
      const models = fieldOf(answer, 'models');
      return isRecord(answer) && Array.isArray(models)
        ? {
            ...answer,
            models: models.map((name: unknown) => (name === '' ? null : name)),
          }
        : answer;
    }),
  };
};

/**
 * A wire kind as today's: the wire cannot tell an absent `options` from an
 * empty one, so a field that is not `enum` with none reads as without them.
 */
const kindOf = (value: unknown): unknown => {
  const fields = fieldOf(value, 'fields');
  if (!isRecord(value) || !Array.isArray(fields)) return value;
  return {
    ...value,
    fields: fields.map((field: unknown) => {
      if (!isRecord(field)) return field;
      const { options, ...rest } = field;
      return field.kind !== 'enum' &&
        Array.isArray(options) &&
        options.length === 0
        ? rest
        : field;
    }),
  };
};

/** A replacement's answer (`{status, …}`) as the configuration it activated. */
const replaced = (result: unknown): DoricConfiguration => {
  if (!isRecord(result)) return invalidResponse();
  if (result.status === 'replaced')
    return doricConfigurationFrom(result.config);
  if (result.status === 'invalid' && typeof result.message === 'string')
    return fail('invalid_input', result.message);
  return fail('internal', 'The Doric configuration could not be activated.');
};

/** A record's `key` field, or `undefined` for anything else. */
const fieldOf = (value: unknown, key: string): unknown =>
  isRecord(value) ? value[key] : undefined;

/** The adapter over one bundle activation's services. */
export const createSettingsApi = (services: Services): SettingsApi => {
  const client = services as ClientServices;
  return {
    config: {
      get: async () =>
        doricConfigurationFrom(
          fieldOf(
            decode(
              CurrentResponseSchema,
              await reach(() => client.use(HostConfigService).current({})),
            ),
            'doricConfiguration',
          ),
        ),
      update: async (configuration) => {
        const input = desktopConfiguration(configuration);
        let result: unknown;
        try {
          result = decode(
            ReplaceResponseSchema,
            await client
              .use(HostConfigService)
              .replace(encode(ReplaceRequestSchema, { input })),
          );
        } catch (failure) {
          // The route answered any failure of the replacement as a rejection;
          // a host out of reach never got that far.
          const error = contractError(failure);
          if (isContractError(error) && unreachable.has(error.code))
            return fail(error.code, unavailableMessage, error);
          return fail(
            'internal',
            'The Doric configuration could not be activated.',
          );
        }
        return replaced(result);
      },
    },
    tools: {
      catalog: async () =>
        toolCatalogFrom(
          fieldOf(
            decode(
              ToolCatalogResponseSchema,
              await reach(() => client.use(ToolsService).catalog({})),
            ),
            'entries',
          ),
        ),
    },
    providers: {
      kinds: async () => {
        const kinds = fieldOf(
          decode(
            KindsResponseSchema,
            await reach(() => client.use(ModelsService).kinds({})),
          ),
          'kinds',
        );
        if (!Array.isArray(kinds)) return invalidResponse();
        return kinds.map((kind) => providerKindFrom(kindOf(kind)));
      },
      models: async (values) => {
        const guarded = guardedProviderValues(values);
        const kindId = guarded.kind.trim();
        if (kindId.length < 1 || kindId.length > 128) return invalidProvider();
        const models = client.use(ModelsService);
        const { modelKindDescriptor } = await reach(() =>
          models.kind({ id: kindId }),
        );
        if (modelKindDescriptor === undefined) return invalidProvider();
        const parsed = modelsMethods.kind.output.safeParse(
          decode(ModelKindDescriptorSchema, modelKindDescriptor),
        );
        if (!parsed.success) return invalidResponse();
        const kind = parsed.data;
        if (kind === undefined || !fieldsAccepted(kind, guarded.configuration))
          return invalidProvider();
        const read = fieldOf(
          decode(
            CatalogResponseSchema,
            await reach(() =>
              models.catalog({
                kind: kind.id,
                configuration: guarded.configuration,
              }),
            ),
          ),
          'catalogResult',
        );
        if (fieldOf(read, 'status') !== 'read')
          return fail(
            'internal',
            'The provider model catalog could not be read.',
          );
        return catalogFrom(fieldOf(read, 'models'));
      },
      icons: async (requests) => {
        if (requests.length === 0) return { svgs: {}, answers: [] };
        const answer = await reach(() =>
          client.use(ModelsService).icons(
            encode(IconsRequestSchema, {
              requests: requests.map(({ kind, configuration, models }) => ({
                kind,
                configuration,
                models,
              })),
            }),
          ),
        );
        return iconAnswersFrom(
          iconsOf(decode(IconsResponseSchema, answer)),
          requests,
        );
      },
    },
    credentials: {
      list: async () => {
        const listed = fieldOf(
          decode(
            ListResponseSchema,
            await reach(() => client.use(SecretsService).list({})),
          ),
          'credentials',
        );
        if (!Array.isArray(listed)) return invalidResponse();
        return listed
          .filter((entry) => !isUnmanagedCredential(entry))
          .map(credentialFrom);
      },
      create: async (input) => {
        const create = routeCreate(guardedCredentialCreate(input));
        let created: unknown;
        try {
          created = fieldOf(
            decode(
              CreateResponseSchema,
              await client
                .use(SecretsService)
                .create(encode(CreateRequestSchema, create)),
            ),
            'credentialDescription',
          );
        } catch (error) {
          return credentialWriteFailure(error);
        }
        return credentialFrom(created);
      },
      update: async (id, input) => {
        const credentialId = routeCredentialId(guardedIdentifier(id));
        // A field the update keeps is absent: the wire has no `null`.
        const update = routeUpdate(guardedCredentialUpdate(input));
        let updated: unknown;
        try {
          updated = fieldOf(
            decode(
              UpdateResponseSchema,
              await client.use(SecretsService).update({
                ref: { id: credentialId },
                update: encode(CredentialUpdateSchema, update),
              }),
            ),
            'credentialDescription',
          );
        } catch (error) {
          return credentialWriteFailure(error);
        }
        return credentialFrom(updated);
      },
      remove: async (id) => {
        const credentialId = routeCredentialId(guardedIdentifier(id));
        const { result } = await reach(() =>
          client
            .use(SecretsService)
            .delete({ credentialRef: { id: credentialId } }),
        );
        if (result === 'missing') return fail('not_found', credentialNotFound);
        if (result === 'referenced')
          return fail('conflict', credentialConflict);
      },
    },
    dashboard: {
      active: () =>
        dashboardAvailable
          ? services.use(WorkspaceDashboardV1).active()
          : undefined,
      show: (id) => {
        if (dashboardAvailable) services.use(WorkspaceDashboardV1).show(id);
      },
      subscribe: (listener) =>
        dashboardAvailable
          ? services.use(WorkspaceDashboardV1).subscribe(listener)
          : { dispose: () => undefined },
    },
    openBrowser: async (url) => {
      await services.use(DoricBrowserV1).open(url);
    },
  };
};

/**
 * Whether a `workspace.dashboard/v1` provider answers: the contract is optional,
 * so a composition without `workspace` keeps working settings and simply has
 * no dashboard to draw into. The client part's activation sets it through
 * `whenAvailable`.
 */
let dashboardAvailable = false;

/** Records whether a `workspace.dashboard/v1` provider is active. */
export const setDashboardAvailable = (available: boolean): void => {
  dashboardAvailable = available;
};

let active: SettingsApi | undefined;
let activeServices: Services | undefined;

/** Binds the module adapter to the bundle's activation services (D9-17). */
export const initSettingsApi = (services: Services | undefined): void => {
  activeServices = services;
  active = services === undefined ? undefined : createSettingsApi(services);
};

/**
 * The activation services `initSettingsApi` bound (D9-17). The provider page
 * creates another bundle's element through these, not an element's services,
 * which hand back a scoped view of an element that carries calls of its own
 * rather than the element itself.
 */
export const settingsServices = (): Services => {
  if (activeServices === undefined) {
    throw new SettingsApiError('internal', 'Doric backend is unavailable.', {
      retryable: false,
    });
  }
  return activeServices;
};

/** The adapter the hooks call; the bundle is active while its UI exists. */
export const api = (): SettingsApi => {
  if (active === undefined) {
    throw new SettingsApiError('internal', 'Doric backend is unavailable.', {
      retryable: false,
    });
  }
  return active;
};
