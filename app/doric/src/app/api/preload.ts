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
import type { ThreadHistory } from '../../workspace/thread-history';

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
  /** The Thread's own working directory, absolute inside its Project's sandbox. */
  readonly cwd: string;
  /** `git` or `github` when the working directory's own root holds one. */
  readonly cwdRepo?: 'git' | 'github';
  /** The prompt the Thread is running, present only while one is. */
  readonly activePromptId?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
};

type GitOperation = 'merge' | 'rebase' | 'cherry-pick' | 'revert' | 'bisect';

/**
 * The Git summary of one Thread's working directory. `repo: false` says the
 * directory holds, or lies in, no repository; every other field describes the
 * one it does lie in.
 */
type ThreadGit =
  | { readonly repo: false }
  | {
      readonly repo: true;
      readonly root: string;
      readonly head: string;
      readonly detached: boolean;
      readonly unborn: boolean;
      readonly upstream: string | null;
      readonly ahead: number;
      readonly behind: number;
      readonly dirty: {
        readonly staged: number;
        readonly modified: number;
        readonly untracked: number;
      };
      readonly conflicted: number;
      readonly operation: GitOperation | null;
      readonly worktree: boolean;
      readonly shallow: boolean;
      readonly stash: number;
      readonly submodules: number;
    };

type ReasoningEffort =
  | 'none'
  | 'minimal'
  | 'low'
  | 'medium'
  | 'high'
  | 'xhigh'
  | 'max';

/** The kinds of control a provider field needs; an `enum` carries its options. */
type ProviderFieldKind = 'text' | 'url' | 'number' | 'enum' | 'secret';

/**
 * One value a provider kind declares. A `secret` value is the id of a stored
 * `API_TOKEN` credential, so no secret itself ever crosses this boundary.
 */
type ProviderField = {
  readonly key: string;
  readonly label: string;
  readonly kind: ProviderFieldKind;
  readonly required: boolean;
  readonly description?: string;
  readonly placeholder?: string;
  readonly options?: readonly string[];
  /** Whether an operator rarely needs the field, so a screen can shelve it. */
  readonly advanced?: boolean;
};

/** One model a provider's catalog describes, as the host answers it. */
type CatalogModel = {
  readonly id: string;
  readonly name?: string;
  readonly reasonings: readonly ReasoningEffort[];
  readonly parameters: readonly string[];
};

/** The values one provider carries, as a catalog read names it. */
type ProviderValuesRef = {
  readonly kind: string;
  readonly configuration: Readonly<Record<string, string>>;
};

type ProviderListId = 'models' | 'reasonings';

/** One provider integration the host can configure and this window may edit. */
type ProviderKind = {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  readonly fields: readonly ProviderField[];
  readonly lists: readonly ProviderListId[];
};

/** The value kinds a tool configuration field can carry. */
type ToolConfigFieldKind = 'text' | 'url' | 'number' | 'enum' | 'secret';

/** One configuration field a tool declares, as the host answers it. */
type ToolConfigField = {
  readonly key: string;
  readonly label: string;
  readonly kind: ToolConfigFieldKind;
  readonly required: boolean;
  readonly description?: string;
  readonly placeholder?: string;
  readonly default?: string;
  readonly options?: readonly string[];
  readonly advanced?: boolean;
};

/** One tool the loaded bundles expose, with the fields it declares. */
type ToolCatalogEntry = {
  readonly name: string;
  readonly description?: string;
  readonly settings: readonly ToolConfigField[];
};

/** One model a provider offers, with its own efforts when the kind keeps them. */
type ProviderModel = {
  readonly name: string;
  readonly reasonings?: readonly ReasoningEffort[];
  /** The effort the catalog names as this model's own, when it names one. */
  readonly defaultEffort?: ReasoningEffort;
  /** Whether the catalog pins reasoning on for this model. */
  readonly mandatory?: boolean;
};

type ProviderConfiguration = {
  readonly id: string;
  readonly kind: string;
  /** The kind's own field values; a `secret` value names a stored credential. */
  readonly configuration: Readonly<Record<string, string>>;
  readonly models?: readonly ProviderModel[];
};

type CredentialKind = 'API_TOKEN' | 'USERNAME_PASSWORD' | 'GIT';

/** A credential as the host answers it; the secret itself never arrives. */
type Credential = {
  readonly id: string;
  readonly kind: CredentialKind;
  readonly name: string;
  readonly username?: string;
  readonly email?: string;
  readonly hasSecret: boolean;
};

type CredentialCreate = {
  readonly kind: CredentialKind;
  readonly name: string;
  readonly username?: string;
  readonly email?: string;
  readonly secret?: string;
};

type CredentialUpdate = {
  readonly kind?: CredentialKind;
  readonly name?: string;
  readonly username?: string | null;
  readonly email?: string | null;
  readonly secret?: string | null;
};

type Configuration = {
  readonly providers: readonly ProviderConfiguration[];
  readonly models: {
    readonly execution: {
      readonly providerId: string;
      readonly model: string;
      /** The effort the model accepts; absent when it lists none. */
      readonly effort?: ReasoningEffort;
    };
  };
  readonly execution: {
    readonly maxTurns: number;
    /** The most one tool result may carry into the model, in characters. */
    readonly maxToolResultChars?: number;
  };
  /** The `GIT` credential the agent's git commands commit as. */
  readonly gitCredentialId?: string;
  /** The `API_TOKEN` credential the sandbox authenticates GitHub with. */
  readonly githubCredentialId?: string;
};

/** The configuration a save sends: a plain replacement of the host's copy. */
type ConfigurationInput = Configuration;

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

type ProjectChangeSet = {
  readonly path: string;
  readonly diff: string;
  readonly changes: readonly ProjectChange[];
};

type ProjectDiff = {
  readonly path?: string;
  readonly repositories: readonly ProjectChangeSet[];
};

type ProjectFilesResult =
  | {
      readonly status: 'ready';
      readonly path: string;
      readonly entries: readonly ProjectFileEntry[];
    }
  | { readonly status: ProjectLeaseState; readonly retryAfterSeconds?: number }
  | { readonly status: 'invalid_path' | 'not_found' };

/** One tree node: a file, or a directory that carries its own children. */
type ProjectTreeNode = ProjectFileEntry & {
  readonly children?: readonly ProjectTreeNode[];
};

type ProjectTreeResult =
  | {
      readonly status: 'ready';
      readonly path: string;
      readonly entries: readonly ProjectTreeNode[];
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

let projectListener: ((update: ProjectUpdate) => void) | undefined;
ipcRenderer.on(projectUpdateChannel, (_event, update: ProjectUpdate) => {
  projectListener?.(update);
});

/**
 * The listener of every Thread this window watches, by Thread id. Each update
 * is handed to the watch of the Thread it names, so a stream can never draw one
 * Thread's events inside another's conversation.
 */
const threadIdOf = (update: ThreadUpdate): string | undefined => {
  switch (update.kind) {
    case 'snapshot':
      return update.snapshot.threadId;
    case 'event':
      return update.event.threadId;
    case 'updated':
      return update.thread.id;
    case 'deleted':
      return update.threadId;
    case 'error':
      return update.threadId;
  }
};

const threadListeners = new Map<string, (update: ThreadUpdate) => void>();
ipcRenderer.on(threadUpdateChannel, (_event, update: ThreadUpdate) => {
  const threadId = threadIdOf(update);
  if (threadId !== undefined) threadListeners.get(threadId)?.(update);
});

contextBridge.exposeInMainWorld('doric', {
  connection: {
    status: connection.status,
    subscribe: connection.subscribe,
  },
  config: {
    get: () => invoke<DoricConfiguration>('doric:config:get'),
    update: (configuration: ConfigurationInput) =>
      invoke<DoricConfiguration>('doric:config:update', configuration),
  },
  tools: {
    // The host's catalog: the tools the loaded bundles expose, and the
    // configuration fields each one declares.
    catalog: () => invoke<readonly ToolCatalogEntry[]>('doric:tools:catalog'),
  },
  providers: {
    // The host's catalog: the kinds it can build and what each one needs.
    kinds: () => invoke<readonly ProviderKind[]>('doric:providers:kinds'),
    // What one provider's own catalog lists, read on the host's side because
    // this window never opens HTTP. The values are the draft's, so a provider
    // page reads its models before the provider exists.
    models: (values: ProviderValuesRef) =>
      invoke<readonly CatalogModel[]>('doric:providers:models', values),
  },
  /**
   * The host's credential store. A create or patch carries a secret and the
   * answer to either is the public view, so no stored secret ever comes back
   * across this boundary.
   */
  credentials: {
    list: () => invoke<readonly Credential[]>('doric:credentials:list'),
    create: (input: CredentialCreate) =>
      invoke<Credential>('doric:credentials:create', input),
    update: (id: string, input: CredentialUpdate) =>
      invoke<Credential>('doric:credentials:update', id, input),
    remove: (id: string) => invoke<void>('doric:credentials:remove', id),
  },
  projects: {
    list: () => invoke<readonly Project[]>('doric:projects:list'),
    files: (projectId: string, path?: string) =>
      invoke<ProjectFilesResult>('doric:projects:files', projectId, path),
    file: (projectId: string, path: string) =>
      invoke<ProjectFileResult>('doric:projects:file', projectId, path),
    tree: (projectId: string, path?: string) =>
      invoke<ProjectTreeResult>('doric:projects:tree', projectId, path),
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
  settings: {
    // Opens the settings window, or focuses it when it is already open.
    open: () => ipcRenderer.invoke('doric:settings:open') as Promise<void>,
    /**
     * Settles a change still waiting on the save debounce, answering the main
     * process's held-back close. The subscription returns its own unsubscribe.
     */
    onFlush: (listener: () => void | Promise<void>) => {
      const handler = (): void => {
        void Promise.resolve(listener()).then(() =>
          ipcRenderer.invoke('doric:settings:flushed'),
        );
      };
      ipcRenderer.on('doric:settings:flush', handler);
      return () => {
        ipcRenderer.removeListener('doric:settings:flush', handler);
      };
    },
  },
  threads: {
    list: (projectId: string) =>
      invoke<readonly Thread[]>('doric:threads:list', projectId),
    get: (id: string) => invoke<Thread | undefined>('doric:threads:get', id),
    // The local snapshot of one Thread's durable log, or `null` when the app
    // holds none; a conversation opens from it before the stream answers.
    history: (id: string) =>
      invoke<ThreadHistory | null>('doric:threads:history', id),
    create: (projectId: string, name: string, parentThreadId?: string) =>
      invoke<Thread>('doric:threads:create', projectId, name, parentThreadId),
    rename: (id: string, name: string) =>
      invoke<Thread>('doric:threads:rename', id, name),
    /** Moves the Thread's working directory and answers the updated Thread. */
    setCwd: (id: string, cwd: string) =>
      invoke<Thread>('doric:threads:set-cwd', id, cwd),
    /** The Git summary of the Thread's working directory, probed on the host. */
    git: (id: string) => invoke<ThreadGit>('doric:threads:git', id),
    prompt: (id: string, prompt: string) =>
      invoke<{ readonly promptId: string }>('doric:threads:prompt', id, prompt),
    /**
     * Takes up a prompt an interruption left unfinished again on the host, which
     * answers the Thread it is running it on.
     */
    resume: (id: string, promptId: string) =>
      invoke<Thread>('doric:threads:resume', id, promptId),
    watch: (
      id: string,
      afterSequence: number,
      listener: (update: ThreadUpdate) => void,
    ) => {
      threadListeners.set(id, listener);
      ipcRenderer.send('doric:threads:watch', id, afterSequence);
      // Releasing one watch never touches another Thread's, and calling it
      // twice, or after a newer watch of the same Thread, does nothing.
      return () => {
        if (threadListeners.get(id) !== listener) return;
        threadListeners.delete(id);
        ipcRenderer.send('doric:threads:unwatch', id);
      };
    },
    rewind: (id: string, promptId: string, prompt: string) =>
      invoke<{ readonly promptId: string }>(
        'doric:threads:rewind',
        id,
        promptId,
        prompt,
      ),
    interrupt: (id: string, promptId: string) =>
      invoke<void>('doric:threads:interrupt', id, promptId),
    terminate: (id: string) => invoke<Thread>('doric:threads:terminate', id),
    delete: (id: string) => invoke<void>('doric:threads:delete', id),
  },
});
