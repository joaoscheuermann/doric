import { ipcRenderer } from 'electron';

import {
  terminalOutputChannel,
  terminalUpdateChannel,
} from '../../workspace/terminal-events';
import type {
  Terminal,
  TerminalOutputUpdate,
  TerminalUpdate,
} from '../../workspace/terminals';

type Result<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: string };
const invoke = async <T>(channel: string, ...args: unknown[]): Promise<T> => {
  const result = (await ipcRenderer.invoke(channel, ...args)) as Result<T>;
  if (!result.ok) throw new Error(result.error);
  return result.value;
};

const projectListeners = new Map<string, (update: TerminalUpdate) => void>();
const outputListeners = new Map<
  string,
  (update: TerminalOutputUpdate) => void
>();
ipcRenderer.on(
  terminalUpdateChannel,
  (_event, id: string, update: TerminalUpdate) =>
    projectListeners.get(id)?.(update),
);
ipcRenderer.on(
  terminalOutputChannel,
  (_event, id: string, update: TerminalOutputUpdate) =>
    outputListeners.get(id)?.(update),
);

/** Renderer-facing terminal controls, without exposing generic IPC or HTTP. */
export const terminals = {
  list: (projectId: string) =>
    invoke<readonly Terminal[]>('doric:terminals:list', projectId),
  create: (threadId: string) =>
    invoke<Terminal>('doric:terminals:create', threadId),
  input: (id: string, data: string) =>
    invoke<void>('doric:terminals:input', id, data),
  resize: (id: string, cols: number, rows: number) =>
    invoke<void>('doric:terminals:resize', id, cols, rows),
  stop: (id: string) => invoke<void>('doric:terminals:stop', id),
  watchProject(projectId: string, listener: (update: TerminalUpdate) => void) {
    projectListeners.set(projectId, listener);
    ipcRenderer.send('doric:terminals:watch-project', projectId);
    return () => {
      if (projectListeners.get(projectId) !== listener) return;
      projectListeners.delete(projectId);
      ipcRenderer.send('doric:terminals:unwatch-project', projectId);
    };
  },
  watch(
    id: string,
    _afterSequence: number,
    listener: (update: TerminalOutputUpdate) => void,
  ) {
    outputListeners.set(id, listener);
    ipcRenderer.send('doric:terminals:watch', id);
    return () => {
      if (outputListeners.get(id) !== listener) return;
      outputListeners.delete(id);
      ipcRenderer.send('doric:terminals:unwatch', id);
    };
  },
};
