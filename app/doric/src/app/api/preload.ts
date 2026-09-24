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
  readonly color?: string;
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

type ReasoningEffort = 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';

type ProviderConfiguration = {
  readonly id: string;
  readonly baseUrl: string;
  readonly apiKeyEnv: string;
};

type Configuration = {
  readonly providers: readonly ProviderConfiguration[];
  readonly models: {
    readonly execution: {
      readonly providerId: string;
      readonly model: string;
      readonly effort: ReasoningEffort;
    };
  };
  readonly execution: { readonly maxTurns: number };
};

type DoricConfiguration = {
  readonly configuration: Configuration;
  readonly revision: number;
  readonly updatedAt: string;
};

type Result<Value> =
  | { readonly ok: true; readonly value: Value }
  | { readonly ok: false; readonly error: string };

type ProjectLeaseState = 'missing' | 'pending' | 'expired' | 'unavailable';

type ProjectFileEntry = {
  readonly name: string;
  readonly path: string;
  readonly type: 'directory' | 'file';
  readonly size?: number;
};

type ProjectFileContent = {
  readonly path: string;
  readonly content: string;
  readonly truncated: boolean;
  readonly binary: boolean;
};

type ProjectChangeStatus =
  | 'added'
  | 'modified'
  | 'deleted'
  | 'renamed'
  | 'untracked';

type ProjectChange = {
  readonly path: string;
  readonly status: ProjectChangeStatus;
};

type ProjectDiff = {
  readonly path?: string;
  readonly repository: boolean;
  readonly diff: string;
  readonly changes: readonly ProjectChange[];
};

type ProjectFilesResult =
  | {
      readonly status: 'ready';
      readonly path: string;
      readonly entries: readonly ProjectFileEntry[];
    }
  | { readonly status: ProjectLeaseState; readonly retryAfterSeconds?: number }
  | { readonly status: 'invalid_path' | 'not_found' };

type ProjectFileResult =
  | { readonly status: 'ready'; readonly file: ProjectFileContent }
  | { readonly status: ProjectLeaseState; readonly retryAfterSeconds?: number }
  | { readonly status: 'invalid_path' | 'not_found' };

type ProjectDiffResult =
  | { readonly status: 'ready'; readonly diff: ProjectDiff }
  | { readonly status: ProjectLeaseState; readonly retryAfterSeconds?: number }
  | { readonly status: 'invalid_path' | 'not_found' };

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
  config: {
    get: () => invoke<DoricConfiguration>('doric:config:get'),
    update: (configuration: Configuration) =>
      invoke<DoricConfiguration>('doric:config:update', configuration),
  },
  projects: {
    list: () => invoke<readonly Project[]>('doric:projects:list'),
    files: (projectId: string, path?: string) =>
      invoke<ProjectFilesResult>('doric:projects:files', projectId, path),
    file: (projectId: string, path: string) =>
      invoke<ProjectFileResult>('doric:projects:file', projectId, path),
    diff: (projectId: string, path?: string) =>
      invoke<ProjectDiffResult>('doric:projects:diff', projectId, path),
    create: (name: string) => invoke<Project>('doric:projects:create', name),
    rename: (id: string, name: string) =>
      invoke<Project>('doric:projects:rename', id, name),
    setColor: (id: string, color?: string) =>
      invoke<Project>('doric:projects:set-color', id, color),
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
