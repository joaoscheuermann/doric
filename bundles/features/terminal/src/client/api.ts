// The window's terminal calls over the client → host bridge (moved from the
// layout's provisional adapter, before that `app/doric`'s terminal IPC and
// REST client). Each operation keeps the old path's order: the main
// process's payload guard with its messages, the host call, then the REST
// client's reading of the route's answer. Terminal calls carry no deadline
// (Q5).

import { isContractError } from 'bundle/contracts';

import type { TerminalService } from '../contracts/index.js';
import type { Terminal } from './domain/terminals.js';
import { createInputQueue } from './input-queue.js';

export const terminalApiMessages = {
  /** A lost bridge, as for every other host call (stage 8 §14.3). */
  unavailable: 'Doric backend is unavailable.',
  invalidIdentifier: 'The item identifier is invalid.',
  invalidTerminalInput: 'Terminal input is invalid.',
  invalidTerminalDimensions: 'Terminal dimensions are invalid.',
  /** Any failed terminal request, as `workspace/terminals.ts` reported it. */
  terminalFailed: 'Doric could not complete the terminal request.',
  invalidTerminal: 'Doric returned an invalid terminal.',
  invalidTerminalSnapshot: 'Doric returned an invalid terminal snapshot.',
} as const;

/** One terminal's output so far, as `GET /terminals/:id` answered it. */
export type TerminalSnapshotRead = {
  readonly terminal: Terminal;
  readonly output: string;
  readonly offset: number;
  readonly truncated: boolean;
};

export interface TerminalApi {
  list(projectId: string): Promise<readonly Terminal[]>;
  create(threadId: string): Promise<Terminal>;
  snapshot(id: string): Promise<TerminalSnapshotRead>;
  input(id: string, data: string): Promise<void>;
  resize(id: string, cols: number, rows: number): Promise<void>;
  stop(id: string): Promise<void>;
}

export type TerminalHost = Pick<
  TerminalService,
  'list' | 'create' | 'snapshot' | 'input' | 'resize' | 'stop'
>;

const identifier = (value: unknown): string => {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 200 ||
    value.includes('\0')
  ) {
    throw new Error(terminalApiMessages.invalidIdentifier);
  }
  return value;
};

const terminalInput = (value: unknown): string => {
  if (typeof value !== 'string' || value.length > 65_536) {
    throw new Error(terminalApiMessages.invalidTerminalInput);
  }
  return value;
};

const terminalDimension = (value: unknown): number => {
  if (
    typeof value !== 'number' ||
    !Number.isInteger(value) ||
    value < 1 ||
    value > 1000
  ) {
    throw new Error(terminalApiMessages.invalidTerminalDimensions);
  }
  return value;
};

/** The old terminal REST client answered every failed request with one sentence. */
const terminalHost = async <Value>(
  operation: () => Promise<Value>,
): Promise<Value> => {
  try {
    return await operation();
  } catch (error) {
    if (
      isContractError(error) &&
      (error.code === 'unavailable' ||
        error.code === 'disconnected' ||
        error.code === 'generation_lost')
    ) {
      throw new Error(terminalApiMessages.unavailable);
    }
    throw new Error(terminalApiMessages.terminalFailed);
  }
};

const record = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

/** A terminal record checked and copied field by field, as the main process did. */
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
    throw new Error(terminalApiMessages.invalidTerminal);
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

export const createTerminalApi = (
  terminals: () => TerminalHost,
): TerminalApi => {
  const writes = createInputQueue();

  return {
    list: async (projectId) => {
      const id = identifier(projectId);
      const items = await terminalHost(() => terminals().list(id));
      return items.map(terminalFrom);
    },
    create: async (threadId) => {
      const id = identifier(threadId);
      const terminal = await terminalHost(() => terminals().create(id, {}));
      // `undefined` is the route's 409 `terminal_unavailable`.
      if (terminal === undefined) {
        throw new Error(terminalApiMessages.terminalFailed);
      }
      return terminalFrom(terminal);
    },
    snapshot: async (terminalId) => {
      const id = identifier(terminalId);
      const result = await terminalHost(() => terminals().snapshot(id, 0));
      // `undefined` is the route's 404 `terminal_missing`.
      if (result === undefined) {
        throw new Error(terminalApiMessages.terminalFailed);
      }
      if (
        typeof result.output !== 'string' ||
        !Number.isSafeInteger(result.offset) ||
        result.offset < result.output.length ||
        typeof result.truncated !== 'boolean'
      ) {
        throw new Error(terminalApiMessages.invalidTerminalSnapshot);
      }
      return {
        terminal: terminalFrom(result.terminal),
        output: result.output,
        offset: result.offset,
        truncated: result.truncated,
      };
    },
    input: async (terminalId, data) => {
      const id = identifier(terminalId);
      const text = terminalInput(data);
      await writes.enqueue(id, async () => {
        // `false` is the route's 404 `terminal_missing`.
        if (!(await terminalHost(() => terminals().input(id, text))))
          throw new Error(terminalApiMessages.terminalFailed);
      });
    },
    resize: async (terminalId, cols, rows) => {
      const id = identifier(terminalId);
      const width = terminalDimension(cols);
      const height = terminalDimension(rows);
      if (!(await terminalHost(() => terminals().resize(id, width, height)))) {
        throw new Error(terminalApiMessages.terminalFailed);
      }
    },
    stop: async (terminalId) => {
      const id = identifier(terminalId);
      // The route answers 204 whether or not the terminal still existed.
      await terminalHost(() => terminals().stop(id));
    },
  };
};
