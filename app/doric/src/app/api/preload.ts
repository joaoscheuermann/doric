import { contextBridge, ipcRenderer } from 'electron';

import {
  connectionStatusChannel,
  createConnectionState,
} from '../../connection/ipc';
import type { ConnectionStatus } from '../../connection/status';
import { type ThreadUpdate, threadUpdateChannel } from '../../workspace/events';
import {
  type ProjectUpdate,
  projectUpdateChannel,
} from '../../workspace/project-events';

type Project = {
  readonly id: string;
  readonly name: string;
  readonly state: string;
  readonly createdAt: string;
  readonly updatedAt: string;
};

type Thread = {
  readonly id: string;
  readonly name: string;
  readonly projectId: string;
  readonly parentThreadId?: string;
  readonly state: string;
  readonly createdAt: string;
  readonly updatedAt: string;
};

type Result<Value> =
  | { readonly ok: true; readonly value: Value }
  | { readonly ok: false; readonly error: string };

const invoke = async <Value>(channel: string, ...args: unknown[]) => {
  const result = (await ipcRenderer.invoke(channel, ...args)) as Result<Value>;
  if (!result.ok) {
    throw new Error(result.error);
  }
  return result.value;
};

const connection = createConnectionState();
ipcRenderer.on(connectionStatusChannel, (_event, status: ConnectionStatus) => {
  connection.update(status);
});

let threadListener: ((update: ThreadUpdate) => void) | undefined;
ipcRenderer.on(threadUpdateChannel, (_event, update: ThreadUpdate) => {
  threadListener?.(update);
});

let projectListener: ((update: ProjectUpdate) => void) | undefined;
ipcRenderer.on(projectUpdateChannel, (_event, update: ProjectUpdate) => {
  projectListener?.(update);
});

contextBridge.exposeInMainWorld('doric', {
  connection: {
    status: connection.status,
    subscribe: connection.subscribe,
  },
  projects: {
    list: () => invoke<readonly Project[]>('doric:projects:list'),
    create: (name: string) => invoke<Project>('doric:projects:create', name),
    rename: (id: string, name: string) =>
      invoke<Project>('doric:projects:rename', id, name),
    terminate: (id: string) => invoke<Project>('doric:projects:terminate', id),
    delete: (id: string) => invoke<void>('doric:projects:delete', id),
    watch: (projectId: string, listener: (update: ProjectUpdate) => void) => {
      projectListener = listener;
      ipcRenderer.send('doric:projects:watch', projectId);
      return () => {
        if (projectListener !== listener) return;
        projectListener = undefined;
        ipcRenderer.send('doric:projects:unwatch');
      };
    },
  },
  threads: {
    list: (projectId: string) =>
      invoke<readonly Thread[]>('doric:threads:list', projectId),
    get: (id: string) => invoke<Thread | undefined>('doric:threads:get', id),
    create: (projectId: string, name: string, parentThreadId?: string) =>
      invoke<Thread>('doric:threads:create', projectId, name, parentThreadId),
    rename: (id: string, name: string) =>
      invoke<Thread>('doric:threads:rename', id, name),
    prompt: (id: string, prompt: string) =>
      invoke<{ readonly promptId: string }>('doric:threads:prompt', id, prompt),
    watch: (
      id: string,
      afterSequence: number,
      listener: (update: ThreadUpdate) => void,
    ) => {
      threadListener = listener;
      ipcRenderer.send('doric:threads:watch', id, afterSequence);
      return () => {
        if (threadListener !== listener) return;
        threadListener = undefined;
        ipcRenderer.send('doric:threads:unwatch');
      };
    },
    rewind: (id: string, promptId: string, prompt: string) =>
      invoke<{ readonly promptId: string }>(
        'doric:threads:rewind',
        id,
        promptId,
        prompt,
      ),
    terminate: (id: string) => invoke<Thread>('doric:threads:terminate', id),
    delete: (id: string) => invoke<void>('doric:threads:delete', id),
  },
});
