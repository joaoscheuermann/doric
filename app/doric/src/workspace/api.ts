import { workspaceUrl } from './config';

const pageLimit = 100;

export type Project = {
  readonly id: string;
  readonly name: string;
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
  projects: {
    list: () => allPages<Project>('/projects'),
    create: (name: string) =>
      request<Project>('/projects', { method: 'POST', body: body({ name }) }),
    rename: (projectId: string, name: string) =>
      request<Project>(`/projects/${id(projectId)}`, {
        method: 'PATCH',
        body: body({ name }),
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
