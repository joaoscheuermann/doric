// The codec between terminal/v1's domain shapes (`../contracts/index.ts`) and
// its wire messages (`terminal.proto`), for the host part as a process
// (phase 3, S54b). The `*MessageSchema` names are import aliases of the
// generated `TerminalSessionSchema` and `TerminalSnapshotSchema`; they avoid a
// clash with the contracts' domain types of the same name.

import type { MessageInitShape } from '@bufbuild/protobuf';

import type {
  RunRequest,
  RunResponseSchema,
  TerminalSessionSchema as TerminalSessionMessageSchema,
  TerminalSnapshotSchema as TerminalSnapshotMessageSchema,
  WatchProjectResponseSchema,
} from '../contracts/gen/doric/terminal/v1/terminal_pb.js';
import type {
  BackgroundTerminal,
  TerminalInput,
  TerminalResult,
  TerminalSession,
  TerminalSnapshot,
  TerminalWatchItem,
} from '../contracts/index.js';

/** `RunRequest` → `TerminalInput` (`background`, `pty` only when set). Never throws. */
export const runInputOf = (request: RunRequest): TerminalInput => ({
  command: request.command,
  cwd: request.cwd,
  timeoutMs: request.timeoutMs,
  ...(request.background === undefined
    ? {}
    : { background: request.background }),
  ...(request.pty === undefined ? {} : { pty: request.pty }),
});

/**
 * A run's answer → `RunResponse`: `{terminalId, background: true}` for a
 * background answer; every other field for a result (`exitCode` as int32).
 * Obeys `run_response.shape`.
 */
export const runResponseOf = (
  answer: TerminalResult | BackgroundTerminal,
): MessageInitShape<typeof RunResponseSchema> =>
  'background' in answer
    ? { terminalId: answer.terminalId, background: true }
    : {
        terminalId: answer.terminalId,
        stdout: answer.stdout,
        stderr: answer.stderr,
        exitCode: answer.exitCode,
        durationMs: answer.durationMs,
        reason: answer.reason,
      };

/** A session → the wire's `TerminalSession`: `timeoutMs: null` → absent; `name` only when set. */
export const sessionMessageOf = (
  session: TerminalSession,
): MessageInitShape<typeof TerminalSessionMessageSchema> => ({
  id: session.id,
  projectId: session.projectId,
  threadId: session.threadId,
  origin: session.origin,
  command: session.command,
  cwd: session.cwd,
  startedAt: session.startedAt,
  ...(session.timeoutMs === null ? {} : { timeoutMs: session.timeoutMs }),
  state: session.state,
  pty: session.pty,
  ...(session.name === undefined ? {} : { name: session.name }),
});

/** A snapshot → `TerminalSnapshot` (its `terminal` through `sessionMessageOf`). */
export const snapshotMessageOf = (
  snapshot: TerminalSnapshot,
): MessageInitShape<typeof TerminalSnapshotMessageSchema> => ({
  terminal: sessionMessageOf(snapshot.terminal),
  output: snapshot.output,
  offset: snapshot.offset,
  truncated: snapshot.truncated,
});

/** One watch item → `WatchProjectResponse`, the `oneof item` case named by `kind`. */
export const watchItemMessageOf = (
  item: TerminalWatchItem,
): MessageInitShape<typeof WatchProjectResponseSchema> => {
  switch (item.kind) {
    case 'snapshot':
      return {
        item: {
          case: 'snapshot',
          value: {
            projectId: item.projectId,
            terminals: item.terminals.map(sessionMessageOf),
          },
        },
      };
    case 'updated':
      return {
        item: { case: 'updated', value: sessionMessageOf(item.terminal) },
      };
    case 'removed':
      return {
        item: {
          case: 'removed',
          value: {
            projectId: item.projectId,
            threadId: item.threadId,
            terminalId: item.terminalId,
          },
        },
      };
    case 'output':
      return { item: { case: 'output', value: { ...item.output } } };
  }
};
