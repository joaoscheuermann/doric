import { WorkspaceError } from './api';
import { workspaceUrl } from './config';

export type Terminal = {
  readonly id: string;
  readonly projectId: string;
  readonly threadId: string;
  readonly origin: 'agent' | 'user';
  readonly command: string;
  readonly cwd: string;
  readonly startedAt: string;
  readonly timeoutMs: number | null;
  readonly state: 'starting' | 'running' | 'exited';
  readonly pty: boolean;
};

export type TerminalUpdate =
  | { readonly kind: 'snapshot'; readonly terminals: readonly Terminal[] }
  | { readonly kind: 'updated'; readonly terminal: Terminal }
  | { readonly kind: 'removed'; readonly terminalId: string }
  | { readonly kind: 'error'; readonly message: string };

export type TerminalOutputUpdate =
  | {
      readonly kind: 'snapshot';
      readonly data: string;
      readonly sequence: number;
      readonly truncated?: boolean;
    }
  | {
      readonly kind: 'output';
      readonly data: string;
      readonly sequence: number;
    }
  | { readonly kind: 'error'; readonly message: string };

export type TerminalSnapshot = {
  readonly terminal: Terminal;
  readonly output: string;
  readonly offset: number;
  readonly truncated: boolean;
};

export const record = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

/** Validates host metadata before it crosses the preload boundary. */
export const terminalFrom = (value: unknown): Terminal => {
  const item = record(value);
  if (
    !item ||
    !['id', 'projectId', 'threadId', 'command', 'cwd', 'startedAt'].every(
      (key) => typeof item[key] === 'string',
    ) ||
    !['agent', 'user'].includes(String(item.origin)) ||
    !['starting', 'running', 'exited'].includes(String(item.state)) ||
    typeof item.pty !== 'boolean' ||
    !(
      item.timeoutMs === null ||
      (typeof item.timeoutMs === 'number' &&
        Number.isFinite(item.timeoutMs) &&
        item.timeoutMs >= 0)
    )
  ) {
    throw new WorkspaceError('Doric returned an invalid terminal.');
  }
  const terminal = item as Terminal;
  return {
    id: terminal.id,
    projectId: terminal.projectId,
    threadId: terminal.threadId,
    origin: terminal.origin,
    command: terminal.command,
    cwd: terminal.cwd,
    startedAt: terminal.startedAt,
    timeoutMs: terminal.timeoutMs,
    state: terminal.state,
    pty: terminal.pty,
  };
};

const request = async (
  path: string,
  method = 'GET',
  body?: unknown,
): Promise<unknown> => {
  const response = await fetch(`${workspaceUrl}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!response.ok)
    throw new WorkspaceError(
      'Doric could not complete the terminal request.',
      response.status,
    );
  return response.status === 204 ? undefined : response.json();
};

/** Process controls always execute on Doric's sandbox through the host. */
export const terminalApi = {
  list: async (projectId: string): Promise<readonly Terminal[]> => {
    const result = record(
      await request(`/projects/${encodeURIComponent(projectId)}/terminals`),
    );
    if (!Array.isArray(result?.items))
      throw new WorkspaceError('Doric returned an invalid terminal list.');
    return result.items.map(terminalFrom);
  },
  create: async (threadId: string): Promise<Terminal> =>
    terminalFrom(
      await request(
        `/threads/${encodeURIComponent(threadId)}/terminals`,
        'POST',
        {},
      ),
    ),
  snapshot: async (id: string): Promise<TerminalSnapshot> => {
    const result = record(
      await request(`/terminals/${encodeURIComponent(id)}`),
    );
    if (
      !result ||
      typeof result.output !== 'string' ||
      !Number.isSafeInteger(result.offset) ||
      Number(result.offset) < result.output.length ||
      typeof result.truncated !== 'boolean'
    )
      throw new WorkspaceError('Doric returned an invalid terminal snapshot.');
    return {
      terminal: terminalFrom(result.terminal),
      output: result.output,
      offset: result.offset as number,
      truncated: result.truncated,
    };
  },
  input: async (id: string, data: string): Promise<void> => {
    await request(`/terminals/${encodeURIComponent(id)}/input`, 'POST', {
      data,
    });
  },
  resize: async (id: string, cols: number, rows: number): Promise<void> => {
    await request(`/terminals/${encodeURIComponent(id)}/resize`, 'POST', {
      cols,
      rows,
    });
  },
  stop: async (id: string): Promise<void> => {
    await request(`/terminals/${encodeURIComponent(id)}`, 'DELETE');
  },
};
