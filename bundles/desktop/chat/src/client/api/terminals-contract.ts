// The chat's view of `terminal/v1` and `runtime.terminals/v1`: live terminal
// sessions, their output stream and the stop control. Consumed through
// `whenAvailable` so the chat works with or without a live terminal provider.

import {
  type CallArg,
  type Disposable,
  ref,
  type StreamListener,
} from 'bundle/contracts';
import type {
  RuntimeTerminals,
  Terminal,
  TerminalSnapshot,
  TerminalWatchItem,
} from 'runtime/contracts';

export type { Terminal, TerminalSnapshot, TerminalWatchItem };

export interface TerminalServiceContract {
  snapshot(
    terminalId: string,
    after: number,
    call?: CallArg,
  ): Promise<TerminalSnapshot | undefined>;
  stop(terminalId: string, call?: CallArg): Promise<boolean>;
  watchProject(
    projectId: string,
    listener: StreamListener<TerminalWatchItem>,
    call?: CallArg,
  ): Disposable;
}

export const TerminalServiceV1 = ref<TerminalServiceContract>('terminal/v1');

export interface ChatTerminalsApi {
  snapshot(
    terminalId: string,
    after?: number,
  ): Promise<TerminalSnapshot | undefined>;
  stop(terminalId: string): Promise<boolean>;
  watchProject(
    projectId: string,
    listener: StreamListener<TerminalWatchItem>,
  ): Disposable;
}

export const fromTerminalService = (
  service: TerminalServiceContract,
): ChatTerminalsApi => ({
  snapshot: (terminalId, after = 0) => service.snapshot(terminalId, after),
  stop: (terminalId) => service.stop(terminalId),
  watchProject: (projectId, listener) =>
    service.watchProject(projectId, listener),
});

export const fromRuntimeTerminals = (
  service: RuntimeTerminals,
): ChatTerminalsApi => ({
  snapshot: (id, after = 0) => service.snapshot({ id, after }),
  stop: (id) => service.stop(id),
  watchProject: (projectId, listener) =>
    service.watchProject(projectId, listener),
});
