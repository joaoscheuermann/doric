import { contextBridge, ipcRenderer } from 'electron';

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

contextBridge.exposeInMainWorld('doric', {
  projects: {
    list: () => invoke<readonly Project[]>('doric:projects:list'),
    create: (name: string) => invoke<Project>('doric:projects:create', name),
    rename: (id: string, name: string) =>
      invoke<Project>('doric:projects:rename', id, name),
    terminate: (id: string) => invoke<Project>('doric:projects:terminate', id),
    delete: (id: string) => invoke<void>('doric:projects:delete', id),
  },
  threads: {
    list: (projectId: string) =>
      invoke<readonly Thread[]>('doric:threads:list', projectId),
    create: (projectId: string, name: string, parentThreadId?: string) =>
      invoke<Thread>('doric:threads:create', projectId, name, parentThreadId),
    rename: (id: string, name: string) =>
      invoke<Thread>('doric:threads:rename', id, name),
    terminate: (id: string) => invoke<Thread>('doric:threads:terminate', id),
    delete: (id: string) => invoke<void>('doric:threads:delete', id),
  },
});
