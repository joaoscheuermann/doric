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

export type ProjectDiff = {
  readonly path?: string;
  readonly repository: boolean;
  readonly diff: string;
  readonly changes: readonly ProjectChange[];
};

export type ProjectFilesResult =
  | {
      readonly status: 'ready';
      readonly path: string;
      readonly entries: readonly ProjectFileEntry[];
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
    readonly execution: {
      readonly providerId: string;
      readonly model: string;
      readonly effort: ReasoningEffort;
    };
  };
  readonly execution: { readonly maxTurns: number };
  /** Absent when GitHub was never configured. */
  readonly github?: GitHubConfiguration;
};

/**
 * GitHub as the host answers it: whether a token is stored, never the token.
 * A host that answered with one would have it dropped by `configurationFrom`,
 * so a token cannot reach the renderer even by mistake.
 */
export type GitHubConfiguration = {
  readonly username: string;
  readonly email: string;
  readonly hasToken: boolean;
};

/**
 * The GitHub block a `PUT /config` sends. A token replaces the stored one,
 * `null` or no key keeps it, and `''` clears it.
 */
export type GitHubInput = {
  readonly username: string;
  readonly email: string;
  readonly token?: string | null;
};

/** The configuration a `PUT /config` replaces the host's copy with. */
export type ConfigurationInput = Omit<Configuration, 'github'> & {
  readonly github?: GitHubInput | null;
};

export type DoricConfiguration = {
  readonly configuration: Configuration;
  readonly revision: number;
  readonly updatedAt: string;
};

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
    typeof value.baseUrl !== 'string' ||
    typeof value.apiKeyEnv !== 'string'
  ) {
    return invalidResponse();
  }
  return { id: value.id, baseUrl: value.baseUrl, apiKeyEnv: value.apiKeyEnv };
};

/**
 * A GitHub block read back by known key, so the token the host never answers
 * with — and anything else a host might add — is dropped here.
 */
const githubConfigurationFrom = (
  value: unknown,
): GitHubConfiguration | undefined => {
  if (value === undefined) return undefined;
  if (
    !isRecord(value) ||
    typeof value.username !== 'string' ||
    typeof value.email !== 'string' ||
    typeof value.hasToken !== 'boolean'
  ) {
    return invalidResponse();
  }
  return {
    username: value.username,
    email: value.email,
    hasToken: value.hasToken,
  };
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
    !isReasoningEffort(effort)
  ) {
    return invalidResponse();
  }

  const github = githubConfigurationFrom(value.github);
  return {
    providers: value.providers.map(providerConfigurationFrom),
    models: { execution: { providerId, model, effort } },
    execution: { maxTurns: value.execution.maxTurns },
    ...(github === undefined ? {} : { github }),
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

const diffFrom = (value: unknown): ProjectDiff => {
  if (
    !isRecord(value) ||
    (value.path !== undefined && typeof value.path !== 'string') ||
    typeof value.repository !== 'boolean' ||
    typeof value.diff !== 'string' ||
    !Array.isArray(value.changes)
  ) {
    return invalidResponse();
  }
  return {
    ...(value.path === undefined ? {} : { path: value.path }),
    repository: value.repository,
    diff: value.diff,
    changes: value.changes.map(changeFrom),
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
    terminate: (threadId: string) =>
      request<Thread>(`/threads/${id(threadId)}/terminate`, {
        method: 'POST',
      }),
    delete: (threadId: string) =>
      deleteWhenTerminal(`/threads/${id(threadId)}`),
  },
} as const;
