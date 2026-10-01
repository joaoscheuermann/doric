import { workspaceUrl } from './config';

const pageLimit = 100;

export type Project = {
  readonly id: string;
  readonly name: string;
  readonly color?: string;
  readonly state: string;
  readonly createdAt: string;
  readonly updatedAt: string;
};

export type Thread = {
  readonly id: string;
  readonly name: string;
  readonly projectId: string;
  readonly parentThreadId?: string;
  readonly state: string;
  /** The prompt the Thread is running, present only while one is. */
  readonly activePromptId?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
};

export type PromptReceipt = {
  readonly promptId: string;
};

/** A Project whose sandbox lease is not yet usable, or never will be. */
export type ProjectLeaseState =
  | 'missing'
  | 'pending'
  | 'expired'
  | 'unavailable';

export type ProjectFileEntry = {
  readonly name: string;
  readonly path: string;
  readonly type: 'directory' | 'file';
  readonly size?: number;
};

/** One tree node: a file, or a directory that carries its own children. */
export type ProjectTreeNode = ProjectFileEntry & {
  /** Present for directories; empty when every child is hidden or ignored. */
  readonly children?: readonly ProjectTreeNode[];
};

export type ProjectFileContent = {
  readonly path: string;
  readonly content: string;
  readonly truncated: boolean;
  readonly binary: boolean;
};

export type ProjectChangeStatus =
  | 'added'
  | 'modified'
  | 'deleted'
  | 'renamed'
  | 'untracked';

export type ProjectChange = {
  readonly path: string;
  readonly status: ProjectChangeStatus;
};

export type ProjectChangeSet = {
  readonly path: string;
  readonly diff: string;
  readonly changes: readonly ProjectChange[];
};

/** Every Git repository in the sandbox: one entry per repository. */
export type ProjectDiff = {
  readonly path?: string;
  readonly repositories: readonly ProjectChangeSet[];
};

export type ProjectFilesResult =
  | {
      readonly status: 'ready';
      readonly path: string;
      readonly entries: readonly ProjectFileEntry[];
    }
  | { readonly status: ProjectLeaseState; readonly retryAfterSeconds?: number }
  | { readonly status: 'invalid_path' | 'not_found' };

export type ProjectTreeResult =
  | {
      readonly status: 'ready';
      readonly path: string;
      readonly entries: readonly ProjectTreeNode[];
    }
  | { readonly status: ProjectLeaseState; readonly retryAfterSeconds?: number }
  | { readonly status: 'invalid_path' | 'not_found' };

export type ProjectFileResult =
  | { readonly status: 'ready'; readonly file: ProjectFileContent }
  | { readonly status: ProjectLeaseState; readonly retryAfterSeconds?: number }
  | { readonly status: 'invalid_path' | 'not_found' };

export type ProjectDiffResult =
  | { readonly status: 'ready'; readonly diff: ProjectDiff }
  | { readonly status: ProjectLeaseState; readonly retryAfterSeconds?: number }
  | { readonly status: 'invalid_path' | 'not_found' };

export const reasoningEfforts = [
  'none',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
] as const;

export type ReasoningEffort = (typeof reasoningEfforts)[number];

/** The kinds of control a provider field needs; an `enum` carries its options. */
export type ProviderFieldKind = 'text' | 'url' | 'number' | 'enum' | 'secret';

/**
 * One value a provider kind declares. A `secret` value is the id of a stored
 * `API_TOKEN` credential, so no secret itself ever crosses this boundary.
 */
export type ProviderField = {
  readonly key: string;
  readonly label: string;
  readonly kind: ProviderFieldKind;
  readonly required: boolean;
  readonly description?: string;
  readonly placeholder?: string;
  readonly options?: readonly string[];
  /** Whether an operator rarely needs the field, so a screen can shelve it. */
  readonly advanced?: boolean;
};

/** The per-provider lists a kind keeps: edited as tables, read by other sections. */
export type ProviderListId = 'models' | 'reasonings';

/**
 * One provider integration the host can configure. Its `id` stays a string
 * because the catalog is the host's: a settings surface that received a kind it
 * had never heard of can still render it.
 */
export type ProviderKind = {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  readonly fields: readonly ProviderField[];
  readonly lists: readonly ProviderListId[];
};

/**
 * One model a provider offers. Its name is the model id an execution profile
 * types; when the kind keeps reasoning efforts, the model carries its own, the
 * effort its catalog names as the model's default, and whether that catalog pins
 * reasoning on.
 */
export type ProviderModel = {
  readonly name: string;
  /** The efforts this model accepts, for the kinds whose catalog lists them. */
  readonly reasonings?: readonly ReasoningEffort[];
  /** The effort the catalog names as this model's own; absent when it names none. */
  readonly defaultEffort?: ReasoningEffort;
  /** Whether the catalog pins reasoning on, so no request may turn it off. */
  readonly mandatory?: boolean;
};

export type ProviderConfiguration = {
  readonly id: string;
  /** The kind this provider names, one of the catalog's ids. */
  readonly kind: string;
  /** The kind's own field values; a `secret` value names a stored credential. */
  readonly configuration: Readonly<Record<string, string>>;
  /** The models this provider offers, for the kinds whose catalog lists them. */
  readonly models?: readonly ProviderModel[];
};

/**
 * The kind of a stored credential. A kind is a closed set that fixes which
 * fields the credential carries, and it is immutable once the credential
 * exists.
 */
export const credentialKinds = [
  'API_TOKEN',
  'USERNAME_PASSWORD',
  'GIT',
] as const;

export type CredentialKind = (typeof credentialKinds)[number];

/**
 * A stored credential as the host answers it. `hasSecret` stands in for the
 * secret itself, which never leaves the host: this is the shape every renderer
 * reads, so no view can hold a credential value.
 */
export type Credential = {
  readonly id: string;
  readonly kind: CredentialKind;
  readonly name: string;
  readonly username?: string;
  readonly email?: string;
  readonly hasSecret: boolean;
};

/** The fields a create names, validated against the kind's field set by the host. */
export type CredentialCreate = {
  readonly kind: CredentialKind;
  readonly name: string;
  readonly username?: string;
  readonly email?: string;
  readonly secret?: string;
};

/**
 * The fields a patch may name. Every one follows the same rule — absent or
 * `null` keeps what is stored, `''` clears it, and a value sets it — so a
 * secret is never cleared by a caller that did not mean to.
 */
export type CredentialUpdate = {
  readonly kind?: CredentialKind;
  readonly name?: string;
  readonly username?: string | null;
  readonly email?: string | null;
  readonly secret?: string | null;
};

export type Configuration = {
  readonly providers: readonly ProviderConfiguration[];
  readonly models: {
    readonly execution: {
      readonly providerId: string;
      readonly model: string;
      /**
       * The effort the model accepts; absent when it lists none, because a model
       * whose catalog names no efforts cannot be told one.
       */
      readonly effort?: ReasoningEffort;
    };
  };
  readonly execution: { readonly maxTurns: number };
  /** The `GIT` credential the agent's git commands commit as. */
  readonly gitCredentialId?: string;
  /** The `API_TOKEN` credential the sandbox authenticates GitHub with. */
  readonly githubCredentialId?: string;
};

export type DoricConfiguration = {
  readonly configuration: Configuration;
  readonly revision: number;
  readonly updatedAt: string;
};

/**
 * The configuration a `PUT /config` sends. The body is a plain replacement, so
 * it is exactly the shape `GET /config` answers: nothing is write-only any more,
 * because no secret travels with the configuration.
 */
export type ConfigurationInput = Configuration;

type Page<Value> = {
  readonly items: readonly Value[];
  readonly nextCursor?: string;
};

export class WorkspaceError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

const genericError = 'Doric could not complete the request.';
const invalidResponse = (): never => {
  throw new WorkspaceError('Doric returned an invalid response.');
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const threadFrom = (value: unknown): Thread => {
  if (
    !isRecord(value) ||
    typeof value.id !== 'string' ||
    typeof value.name !== 'string' ||
    typeof value.projectId !== 'string' ||
    (value.parentThreadId !== undefined &&
      typeof value.parentThreadId !== 'string') ||
    typeof value.state !== 'string' ||
    typeof value.createdAt !== 'string' ||
    typeof value.updatedAt !== 'string'
  ) {
    return invalidResponse();
  }
  return value as Thread;
};

const reasoningEffortValues = new Set<string>(reasoningEfforts);

const isReasoningEffort = (value: unknown): value is ReasoningEffort =>
  typeof value === 'string' && reasoningEffortValues.has(value);

const providerConfigurationFrom = (value: unknown): ProviderConfiguration => {
  if (
    !isRecord(value) ||
    typeof value.id !== 'string' ||
    typeof value.kind !== 'string'
  ) {
    return invalidResponse();
  }

  const models = providerModelsFrom(value.models);

  return {
    id: value.id,
    kind: value.kind,
    configuration: configurationValuesFrom(value.configuration),
    ...(models === undefined ? {} : { models }),
  };
};

/** A provider's field values: one string per key, and nothing else. */
const configurationValuesFrom = (value: unknown): Record<string, string> => {
  if (!isRecord(value) || Array.isArray(value)) return invalidResponse();

  const entries = Object.entries(value);
  if (entries.some(([, entry]) => typeof entry !== 'string'))
    return invalidResponse();

  return Object.fromEntries(entries as readonly [string, string][]);
};

/** A provider list, or nothing when the kind keeps none. */
const stringListFrom = (value: unknown): readonly string[] | undefined => {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string'))
    return invalidResponse();

  return value as readonly string[];
};

/** One model a provider offers: its name, and the reasoning its kind keeps. */
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

/** A provider's model list, or nothing when the kind keeps none. */
const providerModelsFrom = (
  value: unknown,
): readonly ProviderModel[] | undefined => {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) return invalidResponse();

  return value.map(providerModelFrom);
};

/** A provider's reasoning list, which only names efforts llms knows. */
const reasoningListFrom = (
  value: unknown,
): readonly ReasoningEffort[] | undefined => {
  const list = stringListFrom(value);
  if (list === undefined) return undefined;
  if (!list.every(isReasoningEffort)) return invalidResponse();

  return list;
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

  // An `enum` is the only kind that offers values, so the two must agree: a
  // control the catalog cannot describe would render as an empty choice.
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

/**
 * One model a provider's catalog describes: what the endpoint calls it, the
 * reasoning efforts it accepts, and every request parameter it advertises. The
 * efforts are the closed set every endpoint agrees on, so a value this window
 * cannot send is not one it forwards.
 */
export type CatalogModel = {
  readonly id: string;
  readonly name?: string;
  readonly reasonings: readonly ReasoningEffort[];
  readonly parameters: readonly string[];
};

/** The values one provider carries, as a catalog read names it. */
export type ProviderValuesRef = {
  readonly kind: string;
  readonly configuration: Readonly<Record<string, string>>;
};

/**
 * The host's catalog, unwrapped from the envelope the route answers with.
 */
const catalogFrom = (value: unknown): readonly CatalogModel[] => {
  if (!isRecord(value) || !Array.isArray(value.models))
    return invalidResponse();

  return value.models.map((entry) => {
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

/**
 * The host's provider-kind catalog, unwrapped from the envelope the route
 * answers with.
 */
const providerKindsFrom = (value: unknown): readonly ProviderKind[] => {
  if (!isRecord(value) || !Array.isArray(value.kinds)) return invalidResponse();

  return value.kinds.map(providerKindFrom);
};

const credentialKindValues = new Set<string>(credentialKinds);

const isCredentialKind = (value: unknown): value is CredentialKind =>
  typeof value === 'string' && credentialKindValues.has(value);

/**
 * A credential read back by known key. The secret is not among them, so a host
 * that answered with one would have it dropped here rather than reaching a view.
 */
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

/** A reference the configuration names, or nothing when it names none. */
const credentialReferenceFrom = (value: unknown): string | undefined => {
  if (value === undefined) return undefined;
  return typeof value === 'string' ? value : invalidResponse();
};

const configurationFrom = (value: unknown): Configuration => {
  if (
    !isRecord(value) ||
    !Array.isArray(value.providers) ||
    !isRecord(value.models) ||
    !isRecord(value.models.execution) ||
    !isRecord(value.execution) ||
    typeof value.execution.maxTurns !== 'number'
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
  return {
    providers: value.providers.map(providerConfigurationFrom),
    models: {
      execution: {
        providerId,
        model,
        ...(effort === undefined ? {} : { effort }),
      },
    },
    execution: { maxTurns: value.execution.maxTurns },
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

const promptReceiptFrom = (value: unknown): PromptReceipt => {
  if (
    !isRecord(value) ||
    typeof value.promptId !== 'string' ||
    value.promptId.length === 0
  ) {
    return invalidResponse();
  }
  return { promptId: value.promptId };
};

export const messageFromErrorEnvelope = (value: unknown): string => {
  if (typeof value !== 'object' || value === null || !('error' in value)) {
    return genericError;
  }

  const error = value.error;
  if (
    typeof error !== 'object' ||
    error === null ||
    !('code' in error) ||
    typeof error.code !== 'string' ||
    error.code.length === 0 ||
    !('message' in error) ||
    typeof error.message !== 'string' ||
    error.message.length === 0
  ) {
    return genericError;
  }

  return error.message;
};

/** The error envelope's stable code, read beside the human message. */
export const codeFromErrorEnvelope = (value: unknown): string | undefined => {
  if (!isRecord(value) || !isRecord(value.error)) return undefined;
  const code = value.error.code;
  return typeof code === 'string' && code.length > 0 ? code : undefined;
};

const request = async <Value>(
  path: string,
  init?: RequestInit,
): Promise<Value> => {
  let response: Response;
  try {
    response = await fetch(`${workspaceUrl}${path}`, {
      ...init,
      headers:
        init?.body === undefined
          ? undefined
          : { 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    throw new WorkspaceError('Doric backend is unavailable.');
  }

  if (!response.ok) {
    let envelope: unknown;
    try {
      envelope = await response.json();
    } catch {
      throw new WorkspaceError(genericError);
    }
    throw new WorkspaceError(
      messageFromErrorEnvelope(envelope),
      response.status,
    );
  }
  if (response.status === 204) return undefined as Value;

  try {
    return (await response.json()) as Value;
  } catch {
    throw new WorkspaceError('Doric returned an invalid response.');
  }
};

/**
 * Every answer to a Project filesystem request, including the lease states the
 * renderer renders instead of treating as failures.
 */
type ProjectAnswer =
  | { readonly kind: 'ready'; readonly body: unknown }
  | {
      readonly kind: 'lease';
      readonly state: ProjectLeaseState;
      readonly retryAfterSeconds: number;
    }
  | { readonly kind: 'outcome'; readonly status: 'invalid_path' | 'not_found' };

type ProjectOutcome = Exclude<ProjectAnswer, { kind: 'ready' }>;

/** The shared non-ready arms every Project filesystem result carries. */
const outcomeFrom = (
  answer: ProjectOutcome,
):
  | { readonly status: ProjectLeaseState; readonly retryAfterSeconds?: number }
  | { readonly status: 'invalid_path' | 'not_found' } => {
  if (answer.kind === 'outcome') return { status: answer.status };
  return answer.state === 'pending'
    ? { status: 'pending', retryAfterSeconds: answer.retryAfterSeconds }
    : { status: answer.state };
};

const retryAfterSeconds = (value: string | null): number => {
  if (value === null || value.trim() === '') return 1;
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : 1;
};

/**
 * A status-aware request that returns the answer instead of throwing, so a
 * pending or expired lease can reach the renderer as a state to render.
 */
const requestAnswer = async (
  path: string,
): Promise<{
  readonly status: number;
  readonly body: unknown;
  readonly retryAfterSeconds: number;
}> => {
  let response: Response;
  try {
    response = await fetch(`${workspaceUrl}${path}`, {
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    throw new WorkspaceError('Doric backend is unavailable.');
  }

  let body: unknown;
  try {
    body = response.status === 204 ? undefined : await response.json();
  } catch {
    throw new WorkspaceError('Doric returned an invalid response.');
  }

  return {
    status: response.status,
    body,
    retryAfterSeconds: retryAfterSeconds(response.headers.get('Retry-After')),
  };
};

const projectAnswer = (
  status: number,
  body: unknown,
  seconds: number,
): ProjectAnswer => {
  switch (status) {
    case 200:
      return { kind: 'ready', body };
    case 202:
      return { kind: 'lease', state: 'pending', retryAfterSeconds: seconds };
    case 409:
      return {
        kind: 'lease',
        state: 'unavailable',
        retryAfterSeconds: seconds,
      };
    case 410:
      return { kind: 'lease', state: 'expired', retryAfterSeconds: seconds };
    case 404:
      return codeFromErrorEnvelope(body) === 'project_path_not_found'
        ? { kind: 'outcome', status: 'not_found' }
        : { kind: 'lease', state: 'missing', retryAfterSeconds: seconds };
    case 422:
      return { kind: 'outcome', status: 'invalid_path' };
    default:
      throw new WorkspaceError(messageFromErrorEnvelope(body), status);
  }
};

const changeStatuses: readonly ProjectChangeStatus[] = [
  'added',
  'modified',
  'deleted',
  'renamed',
  'untracked',
];

const fileEntryFrom = (value: unknown): ProjectFileEntry => {
  if (
    !isRecord(value) ||
    typeof value.name !== 'string' ||
    typeof value.path !== 'string' ||
    (value.type !== 'directory' && value.type !== 'file') ||
    (value.size !== undefined && typeof value.size !== 'number')
  ) {
    return invalidResponse();
  }
  return value as ProjectFileEntry;
};

/**
 * One tree node, read the way `fileEntryFrom` reads an entry and then, for a
 * directory, its children in the same shape. A directory's `children` is
 * present even when empty, which is what tells a directory apart from a file.
 */
const treeNodeFrom = (value: unknown): ProjectTreeNode => {
  const entry = fileEntryFrom(value);
  if (!isRecord(value) || value.children === undefined) return entry;
  if (!Array.isArray(value.children)) return invalidResponse();
  return { ...entry, children: value.children.map(treeNodeFrom) };
};

const fileContentFrom = (value: unknown): ProjectFileContent => {
  if (
    !isRecord(value) ||
    typeof value.path !== 'string' ||
    typeof value.content !== 'string' ||
    typeof value.truncated !== 'boolean' ||
    typeof value.binary !== 'boolean'
  ) {
    return invalidResponse();
  }
  return value as ProjectFileContent;
};

const changeFrom = (value: unknown): ProjectChange => {
  if (
    !isRecord(value) ||
    typeof value.path !== 'string' ||
    !changeStatuses.includes(value.status as ProjectChangeStatus)
  ) {
    return invalidResponse();
  }
  return { path: value.path, status: value.status as ProjectChangeStatus };
};

const changeSetFrom = (value: unknown): ProjectChangeSet => {
  if (
    !isRecord(value) ||
    typeof value.path !== 'string' ||
    typeof value.diff !== 'string' ||
    !Array.isArray(value.changes)
  ) {
    return invalidResponse();
  }
  return {
    path: value.path,
    diff: value.diff,
    changes: value.changes.map(changeFrom),
  };
};

const diffFrom = (value: unknown): ProjectDiff => {
  if (
    !isRecord(value) ||
    (value.path !== undefined && typeof value.path !== 'string') ||
    !Array.isArray(value.repositories)
  ) {
    return invalidResponse();
  }
  return {
    ...(value.path === undefined ? {} : { path: value.path }),
    repositories: value.repositories.map(changeSetFrom),
  };
};

const filesResultFrom = (answer: ProjectAnswer): ProjectFilesResult => {
  if (answer.kind !== 'ready') return outcomeFrom(answer);
  if (
    !isRecord(answer.body) ||
    typeof answer.body.path !== 'string' ||
    !Array.isArray(answer.body.entries)
  ) {
    return invalidResponse();
  }
  return {
    status: 'ready',
    path: answer.body.path,
    entries: answer.body.entries.map(fileEntryFrom),
  };
};

const treeResultFrom = (answer: ProjectAnswer): ProjectTreeResult => {
  if (answer.kind !== 'ready') return outcomeFrom(answer);
  if (
    !isRecord(answer.body) ||
    typeof answer.body.path !== 'string' ||
    !Array.isArray(answer.body.entries)
  ) {
    return invalidResponse();
  }
  return {
    status: 'ready',
    path: answer.body.path,
    entries: answer.body.entries.map(treeNodeFrom),
  };
};

const fileResultFrom = (answer: ProjectAnswer): ProjectFileResult => {
  if (answer.kind !== 'ready') return outcomeFrom(answer);
  return { status: 'ready', file: fileContentFrom(answer.body) };
};

const diffResultFrom = (answer: ProjectAnswer): ProjectDiffResult => {
  if (answer.kind !== 'ready') return outcomeFrom(answer);
  return { status: 'ready', diff: diffFrom(answer.body) };
};

/** A workspace-relative path as a query string; the root needs none. */
const pathQuery = (value?: string): string =>
  value === undefined || value === ''
    ? ''
    : `?path=${encodeURIComponent(value)}`;

const answerAt = async (path: string): Promise<ProjectAnswer> => {
  const response = await requestAnswer(path);
  return projectAnswer(
    response.status,
    response.body,
    response.retryAfterSeconds,
  );
};

const id = (value: string): string => encodeURIComponent(value);
const body = (value: object): string => JSON.stringify(value);
const wait = (milliseconds: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

export const retryWhileActive = async (
  operation: () => Promise<void>,
  pause: () => Promise<void> = () => wait(500),
): Promise<void> => {
  for (;;) {
    try {
      await operation();
      return;
    } catch (error) {
      if (!(error instanceof WorkspaceError) || error.status !== 409) {
        throw error;
      }
      await pause();
    }
  }
};

const deleteWhenTerminal = (path: string): Promise<void> =>
  retryWhileActive(() => request<void>(path, { method: 'DELETE' }));

const allPages = async <Value>(path: string): Promise<readonly Value[]> => {
  const items: Value[] = [];
  const cursors = new Set<string>();
  let cursor: string | undefined;

  do {
    const query = new URLSearchParams({ limit: String(pageLimit) });
    if (cursor !== undefined) query.set('cursor', cursor);
    const page = await request<Page<Value>>(`${path}?${query}`);
    if (
      typeof page !== 'object' ||
      page === null ||
      !Array.isArray(page.items) ||
      (page.nextCursor !== undefined && typeof page.nextCursor !== 'string')
    ) {
      throw new WorkspaceError('Doric returned an invalid response.');
    }
    items.push(...page.items);
    cursor = page.nextCursor;
    if (cursor !== undefined && cursors.has(cursor))
      throw new WorkspaceError('Doric returned an invalid response.');
    if (cursor !== undefined) cursors.add(cursor);
  } while (cursor !== undefined);

  return items;
};

/** Confirms the local Doric API answers before the main window opens. */
export const workspaceReady = (): Promise<unknown> => request<unknown>('/vms');

export const workspaceApi = {
  config: {
    get: async () => doricConfigurationFrom(await request<unknown>('/config')),
    update: async (configuration: ConfigurationInput) =>
      doricConfigurationFrom(
        await request<unknown>('/config', {
          method: 'PUT',
          body: body(configuration),
        }),
      ),
  },
  /**
   * The provider kinds the host can build, and the models one provider's catalog
   * describes. The catalog is the host's — this window never opens HTTP — so the
   * kinds let a settings surface configure a kind it has never heard of, and the
   * read lets a provider page offer the models the endpoint itself lists.
   */
  providers: {
    kinds: async (): Promise<readonly ProviderKind[]> =>
      providerKindsFrom(await request<unknown>('/providers/kinds')),
    models: async (
      values: ProviderValuesRef,
    ): Promise<readonly CatalogModel[]> =>
      catalogFrom(
        await request<unknown>('/providers/models', {
          method: 'POST',
          body: body(values),
        }),
      ),
  },
  /**
   * The host's credential store. The list answers every credential in its
   * public shape, and no call here ever receives or sends a stored secret back:
   * a create or patch carries one, and the answer to either is the public view.
   */
  credentials: {
    list: async (): Promise<readonly Credential[]> => {
      const listed = await request<unknown>('/credentials');
      if (!Array.isArray(listed)) return invalidResponse();
      return listed.map(credentialFrom);
    },
    create: async (input: CredentialCreate): Promise<Credential> =>
      credentialFrom(
        await request<unknown>('/credentials', {
          method: 'POST',
          body: body(input),
        }),
      ),
    update: async (id_: string, input: CredentialUpdate): Promise<Credential> =>
      credentialFrom(
        await request<unknown>(`/credentials/${id(id_)}`, {
          method: 'PATCH',
          body: body(input),
        }),
      ),
    remove: (id_: string) =>
      request<void>(`/credentials/${id(id_)}`, { method: 'DELETE' }),
  },
  projects: {
    list: () => allPages<Project>('/projects'),
    /** Lists one workspace directory; an absent path names the root. */
    files: async (
      projectId: string,
      path?: string,
    ): Promise<ProjectFilesResult> =>
      filesResultFrom(
        await answerAt(`/projects/${id(projectId)}/files${pathQuery(path)}`),
      ),
    /** Reads one workspace file; an absent path names the root. */
    file: async (projectId: string, path: string): Promise<ProjectFileResult> =>
      fileResultFrom(
        await answerAt(
          `/projects/${id(projectId)}/files/content${pathQuery(path)}`,
        ),
      ),
    /**
     * Reads the whole sandbox tree in one request. Its own route keeps
     * `files` — one directory level — as it was.
     */
    tree: async (
      projectId: string,
      path?: string,
    ): Promise<ProjectTreeResult> =>
      treeResultFrom(
        await answerAt(`/projects/${id(projectId)}/tree${pathQuery(path)}`),
      ),
    /** Reads the workspace diff; an absent path names the root. */
    diff: async (
      projectId: string,
      path?: string,
    ): Promise<ProjectDiffResult> =>
      diffResultFrom(
        await answerAt(`/projects/${id(projectId)}/diff${pathQuery(path)}`),
      ),
    create: (name: string) =>
      request<Project>('/projects', { method: 'POST', body: body({ name }) }),
    rename: (projectId: string, name: string) =>
      request<Project>(`/projects/${id(projectId)}`, {
        method: 'PATCH',
        body: body({ name }),
      }),
    /** Assigns a palette color, or clears it when none is named. */
    setColor: (projectId: string, color?: string) =>
      request<Project>(`/projects/${id(projectId)}/color`, {
        method: 'PATCH',
        body: body({ color: color ?? null }),
      }),
    terminate: (projectId: string) =>
      request<Project>(`/projects/${id(projectId)}/terminate`, {
        method: 'POST',
      }),
    delete: (projectId: string) =>
      deleteWhenTerminal(`/projects/${id(projectId)}`),
  },
  threads: {
    list: (projectId: string) =>
      allPages<Thread>(`/projects/${id(projectId)}/threads`),
    get: async (threadId: string) => {
      try {
        return threadFrom(await request<unknown>(`/threads/${id(threadId)}`));
      } catch (error) {
        // A deleted Thread is a normal outcome, not a transient failure.
        if (error instanceof WorkspaceError && error.status === 404) {
          return undefined;
        }
        throw error;
      }
    },
    create: (projectId: string, name: string, parentThreadId?: string) =>
      request<Thread>(`/projects/${id(projectId)}/threads`, {
        method: 'POST',
        body: body({ name, ...(parentThreadId ? { parentThreadId } : {}) }),
      }),
    rename: (threadId: string, name: string) =>
      request<Thread>(`/threads/${id(threadId)}`, {
        method: 'PATCH',
        body: body({ name }),
      }),
    prompt: async (threadId: string, prompt: string) =>
      promptReceiptFrom(
        await request<unknown>(`/threads/${id(threadId)}/prompt`, {
          method: 'POST',
          body: body({ prompt }),
        }),
      ),
    /** Replaces an earlier prompt and discards the turns after it. */
    rewind: async (threadId: string, promptId: string, prompt: string) =>
      promptReceiptFrom(
        await request<unknown>(`/threads/${id(threadId)}/rewind`, {
          method: 'POST',
          body: body({ promptId, prompt }),
        }),
      ),
    /** Stops the prompt a Thread is running, leaving its queue alone. */
    interrupt: async (threadId: string, promptId: string) => {
      await request<unknown>(`/threads/${id(threadId)}/interrupt`, {
        method: 'POST',
        body: body({ promptId }),
      });
    },
    terminate: (threadId: string) =>
      request<Thread>(`/threads/${id(threadId)}/terminate`, {
        method: 'POST',
      }),
    delete: (threadId: string) =>
      deleteWhenTerminal(`/threads/${id(threadId)}`),
  },
} as const;
