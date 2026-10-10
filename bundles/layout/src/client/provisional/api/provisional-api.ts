// The provisional features' host adapter (stage 9 §5.8, §5.10): the sandbox,
// git, usage, resource and terminal calls the renderer made through
// `window.doric`, now made over the client → host bridge. Each operation keeps
// the order of the old path:
//
// 1. the main process's payload guard (`workspace/validation.ts`,
//    `workspace/ipc.ts`, `workspace/terminal-ipc.ts`), with its messages;
// 2. the REST route's own input check, whose 422 became a result;
// 3. the host contract, whose outcome is turned into what the main process's
//    REST client answered for the route's status (R-DATA: a lease state stays
//    data), with the same response validation;
// 4. a failure the route answered with an error envelope is an `Error` with
//    that envelope's message (R-ERR).
//
// Stage 10 moves these calls to the `files`, `git`, `terminal`, `usage` and
// `resources` bundles.

import {
  type CallScope,
  isContractError,
  type Services,
} from 'bundle/contracts';
import type { RuntimeLease } from 'runtime/contracts';

import { hostFailure, hostMessages } from '../../api/workspace-api.js';
import type {
  ProjectChange,
  ProjectChangeSet,
  ProjectChangeStatus,
  ProjectChangesResult,
  ProjectDiff,
  ProjectDiffResult,
  ProjectFileChange,
  ProjectFileContent,
  ProjectFileDiffResult,
  ProjectFileEntry,
  ProjectFileResult,
  ProjectFilesResult,
  ProjectLeaseState,
  ProjectTreeNode,
  ProjectTreeResult,
} from '../files/domain/project-files.js';
import type {
  GitBranches,
  GitOperation,
  ThreadGit,
} from '../git/domain/thread-git.js';
import type {
  ContainerResources,
  HostResources,
  ProjectResourcesResult,
} from '../resources/domain/resources.js';
import type {
  Terminal,
  TerminalOutputUpdate,
  TerminalUpdate,
} from '../terminals/domain/terminals.js';
import type { ThreadUsage } from '../usage/domain/usage.js';
import {
  type LeaseHost,
  type ResourcesHost,
  ResourcesV1,
  RuntimeLeaseV1,
  RuntimeTerminalsV1,
  RuntimeThreadsUsageV1,
  type TerminalsHost,
  type UsageHost,
} from './host.js';

export const provisionalMessages = {
  invalidPath: 'The workspace path is invalid.',
  invalidBranch: 'Invalid branch name.',
  invalidWorkingDirectory: 'The working directory is invalid.',
  invalidTerminalInput: 'Terminal input is invalid.',
  invalidTerminalDimensions: 'Terminal dimensions are invalid.',
  /** Any failed terminal request, as `workspace/terminals.ts` reported it. */
  terminalFailed: 'Doric could not complete the terminal request.',
  invalidTerminal: 'Doric returned an invalid terminal.',
  invalidTerminalSnapshot: 'Doric returned an invalid terminal snapshot.',
} as const;

const maximumPathLength = 4096;

// The main process's payload guards ------------------------------------------

const identifier = (value: unknown): string => {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 200 ||
    value.includes('\0')
  ) {
    throw new Error(hostMessages.invalidIdentifier);
  }
  return value;
};

/** `undefined` is the workspace root, `''`. */
const relativePath = (value: unknown): string => {
  if (value === undefined) return '';
  if (
    typeof value !== 'string' ||
    value.includes('\0') ||
    value.length > maximumPathLength ||
    value.startsWith('/') ||
    value.split('/').includes('..')
  ) {
    throw new Error(provisionalMessages.invalidPath);
  }
  return value;
};

const workingDirectory = (value: unknown): string => {
  if (
    typeof value !== 'string' ||
    value.includes('\0') ||
    value.trim().length === 0 ||
    value.length > maximumPathLength
  ) {
    throw new Error(provisionalMessages.invalidWorkingDirectory);
  }
  return value;
};

const branchName = (value: unknown): string => {
  if (
    typeof value !== 'string' ||
    !value ||
    value.length > 1024 ||
    value.includes('\0') ||
    value.startsWith('-')
  ) {
    throw new Error(provisionalMessages.invalidBranch);
  }
  return value;
};

const terminalInput = (value: unknown): string => {
  if (typeof value !== 'string' || value.length > 65_536) {
    throw new Error(provisionalMessages.invalidTerminalInput);
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
    throw new Error(provisionalMessages.invalidTerminalDimensions);
  }
  return value;
};

// Host calls -----------------------------------------------------------------

const host = async <Value>(operation: () => Promise<Value>): Promise<Value> => {
  try {
    return await operation();
  } catch (error) {
    throw hostFailure(error);
  }
};

/**
 * A terminal call: the old terminal REST client answered every failed request
 * with one sentence. A lost bridge is the backend being unavailable, as it is
 * for every other host call (stage 8 §14.3).
 */
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
      throw new Error(hostMessages.unavailable);
    }
    throw new Error(provisionalMessages.terminalFailed);
  }
};

const invalidResponse = (): never => {
  throw new Error(hostMessages.invalidResponse);
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

// Lease reads: the route statuses as the REST client read them ---------------

const leaseStates: ReadonlySet<string> = new Set<ProjectLeaseState>([
  'missing',
  'pending',
  'unavailable',
  'expired',
]);

type Outcome =
  | { readonly status: ProjectLeaseState; readonly retryAfterSeconds?: number }
  | { readonly status: 'invalid_path' | 'not_found' };

/**
 * A non-ready lease read: a lease state (`pending` with the route's
 * `Retry-After: 1`), `not_found` (404 `project_path_not_found`), or any other
 * refusal (422 `invalid_project_path`: `invalid_path`, `not_directory`,
 * `not_file`).
 */
const outcomeOf = (status: string): Outcome => {
  if (status === 'pending') return { status: 'pending', retryAfterSeconds: 1 };
  if (leaseStates.has(status)) {
    return { status: status as ProjectLeaseState };
  }
  if (status === 'not_found') return { status: 'not_found' };
  return { status: 'invalid_path' };
};

const changeStatuses: readonly ProjectChangeStatus[] = [
  'conflicted',
  'added',
  'modified',
  'deleted',
  'renamed',
  'untracked',
];

const fileEntryFrom = (value: unknown): ProjectFileEntry => {
  if (
    !isRecord(value) ||
    typeof value.name !== 'string' ||
    typeof value.path !== 'string' ||
    (value.type !== 'directory' && value.type !== 'file') ||
    (value.size !== undefined && typeof value.size !== 'number')
  ) {
    return invalidResponse();
  }
  return value as ProjectFileEntry;
};

const treeNodeFrom = (value: unknown): ProjectTreeNode => {
  const entry = fileEntryFrom(value);
  if (!isRecord(value) || value.children === undefined) return entry;
  if (!Array.isArray(value.children)) return invalidResponse();
  return { ...entry, children: value.children.map(treeNodeFrom) };
};

const fileContentFrom = (value: unknown): ProjectFileContent => {
  if (
    !isRecord(value) ||
    typeof value.path !== 'string' ||
    typeof value.content !== 'string' ||
    typeof value.truncated !== 'boolean' ||
    typeof value.binary !== 'boolean'
  ) {
    return invalidResponse();
  }
  return {
    path: value.path,
    content: value.content,
    truncated: value.truncated,
    binary: value.binary,
  };
};

const changeFrom = (value: unknown): ProjectChange => {
  if (
    !isRecord(value) ||
    typeof value.path !== 'string' ||
    !changeStatuses.includes(value.status as ProjectChangeStatus)
  ) {
    return invalidResponse();
  }
  return { path: value.path, status: value.status as ProjectChangeStatus };
};

const changeSetFrom = (value: unknown): ProjectChangeSet => {
  if (
    !isRecord(value) ||
    typeof value.path !== 'string' ||
    typeof value.diff !== 'string' ||
    !Array.isArray(value.changes)
  ) {
    return invalidResponse();
  }
  return {
    path: value.path,
    diff: value.diff,
    changes: value.changes.map(changeFrom),
  };
};

const diffFrom = (value: unknown): ProjectDiff => {
  if (
    !isRecord(value) ||
    (value.path !== undefined && typeof value.path !== 'string') ||
    !Array.isArray(value.repositories)
  ) {
    return invalidResponse();
  }
  return {
    ...(value.path === undefined ? {} : { path: value.path }),
    repositories: value.repositories.map(changeSetFrom),
  };
};

const wholeCount = (value: unknown): boolean =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

const fileChangeFrom = (value: unknown): ProjectFileChange => {
  const change = changeFrom(value);
  if (
    !isRecord(value) ||
    typeof value.staged !== 'boolean' ||
    typeof value.unstaged !== 'boolean' ||
    typeof value.indexStatus !== 'string' ||
    typeof value.worktreeStatus !== 'string' ||
    (value.originalPath !== undefined && typeof value.originalPath !== 'string')
  ) {
    return invalidResponse();
  }
  return {
    ...change,
    staged: value.staged,
    unstaged: value.unstaged,
    indexStatus: value.indexStatus,
    worktreeStatus: value.worktreeStatus,
    ...(value.originalPath === undefined
      ? {}
      : { originalPath: value.originalPath }),
  };
};

const changesFrom = (value: {
  readonly path?: string;
  readonly repositories: readonly unknown[];
}): ProjectChangesResult => {
  if (
    !Array.isArray(value.repositories) ||
    (value.path !== undefined && typeof value.path !== 'string')
  ) {
    return invalidResponse();
  }
  const repositories = value.repositories.map((repository: unknown) => {
    if (
      !isRecord(repository) ||
      typeof repository.path !== 'string' ||
      !Array.isArray(repository.changes) ||
      !wholeCount(repository.added) ||
      !wholeCount(repository.removed)
    ) {
      return invalidResponse();
    }
    return {
      path: repository.path,
      changes: repository.changes.map(fileChangeFrom),
      added: repository.added as number,
      removed: repository.removed as number,
    };
  });
  return {
    status: 'ready',
    changes: {
      ...(value.path === undefined ? {} : { path: value.path }),
      repositories,
    },
  };
};

const fileDiffFrom = (value: unknown): ProjectFileDiffResult => {
  const change = fileChangeFrom(value);
  if (
    !isRecord(value) ||
    typeof value.repository !== 'string' ||
    typeof value.original !== 'string' ||
    typeof value.modified !== 'string' ||
    typeof value.binary !== 'boolean' ||
    typeof value.truncated !== 'boolean'
  ) {
    return invalidResponse();
  }
  return {
    status: 'ready',
    diff: {
      ...change,
      repository: value.repository,
      original: value.original,
      modified: value.modified,
      binary: value.binary,
      truncated: value.truncated,
    },
  };
};

const containerResourcesFrom = (value: unknown): ContainerResources => {
  if (
    !isRecord(value) ||
    (value.status !== 'ready' && value.status !== 'unavailable') ||
    typeof value.at !== 'string' ||
    (value.cpuPercent !== undefined && typeof value.cpuPercent !== 'number') ||
    (value.cpuCount !== undefined && typeof value.cpuCount !== 'number') ||
    (value.memoryUsedBytes !== undefined &&
      typeof value.memoryUsedBytes !== 'number') ||
    (value.memoryLimitBytes !== undefined &&
      typeof value.memoryLimitBytes !== 'number')
  ) {
    return invalidResponse();
  }
  return value as ContainerResources;
};

const gitOperations: readonly GitOperation[] = [
  'merge',
  'rebase',
  'cherry-pick',
  'revert',
  'bisect',
];

const threadGitFrom = (value: unknown): ThreadGit => {
  if (!isRecord(value)) return invalidResponse();
  if (value.repo === false) return { repo: false };
  if (
    value.repo !== true ||
    typeof value.root !== 'string' ||
    typeof value.head !== 'string' ||
    typeof value.detached !== 'boolean' ||
    typeof value.unborn !== 'boolean' ||
    (value.upstream !== null && typeof value.upstream !== 'string') ||
    !wholeCount(value.ahead) ||
    !wholeCount(value.behind) ||
    !isRecord(value.dirty) ||
    !wholeCount(value.dirty.staged) ||
    !wholeCount(value.dirty.modified) ||
    !wholeCount(value.dirty.untracked) ||
    !wholeCount(value.conflicted) ||
    (value.operation !== null &&
      !gitOperations.includes(value.operation as GitOperation)) ||
    typeof value.worktree !== 'boolean' ||
    typeof value.shallow !== 'boolean' ||
    !wholeCount(value.stash) ||
    !wholeCount(value.submodules)
  ) {
    return invalidResponse();
  }
  return value as ThreadGit;
};

/** The branch list a route without a live sandbox answers. */
const blockedBranches = (status: 'pending' | 'unavailable'): GitBranches => ({
  status,
  branches: [],
  blocked:
    status === 'pending'
      ? 'Preparing environment…'
      : 'Environment unavailable.',
});

const branchesFrom = (value: unknown): GitBranches => {
  if (
    !isRecord(value) ||
    !Array.isArray(value.branches) ||
    (value.blocked !== undefined && typeof value.blocked !== 'string') ||
    !value.branches.every(
      (branch: unknown) =>
        isRecord(branch) &&
        typeof branch.name === 'string' &&
        typeof branch.current === 'boolean' &&
        typeof branch.commit === 'string' &&
        typeof branch.subject === 'string' &&
        typeof branch.worktree === 'string',
    )
  ) {
    return invalidResponse();
  }
  return value as GitBranches;
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
    throw new Error(provisionalMessages.invalidTerminal);
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

/** One terminal's output so far, as `GET /terminals/:id` answered it. */
export type TerminalSnapshotRead = {
  readonly terminal: Terminal;
  readonly output: string;
  readonly offset: number;
  readonly truncated: boolean;
};

// The adapter ----------------------------------------------------------------

export type TerminalWatchApi = {
  watchProject(
    projectId: string,
    listener: (update: TerminalUpdate) => void,
  ): () => void;
  watch(
    id: string,
    afterSequence: number,
    listener: (update: TerminalOutputUpdate) => void,
  ): () => void;
};

export interface ProvisionalApi {
  readonly projects: {
    files(projectId: string, path?: string): Promise<ProjectFilesResult>;
    file(projectId: string, path: string): Promise<ProjectFileResult>;
    tree(projectId: string, path?: string): Promise<ProjectTreeResult>;
    diff(projectId: string, path?: string): Promise<ProjectDiffResult>;
    changes(projectId: string, path?: string): Promise<ProjectChangesResult>;
    fileDiff(
      projectId: string,
      repository: string,
      path: string,
    ): Promise<ProjectFileDiffResult>;
  };
  readonly threads: {
    usage(id: string): Promise<ThreadUsage>;
    git(id: string): Promise<ThreadGit>;
    branches(id: string): Promise<GitBranches>;
    switchBranch(id: string, branch: string, cwd: string): Promise<GitBranches>;
  };
  readonly resources: {
    host(): Promise<HostResources>;
    project(projectId: string): Promise<ProjectResourcesResult>;
  };
  readonly terminals: {
    list(projectId: string): Promise<readonly Terminal[]>;
    create(threadId: string): Promise<Terminal>;
    /** The terminal's output so far; used by the output watch. */
    snapshot(id: string): Promise<TerminalSnapshotRead>;
    input(id: string, data: string): Promise<void>;
    resize(id: string, cols: number, rows: number): Promise<void>;
    stop(id: string): Promise<void>;
  };
}

export interface ProvisionalHosts {
  /** The lease reads bound to one Project or Thread scope. */
  readonly lease: (scope: CallScope) => LeaseHost;
  readonly terminals: TerminalsHost;
  readonly usage: UsageHost;
  readonly resources: ResourcesHost;
}

/** The query path a REST read sent: the root sends none. */
const pathOf = (path: string): { readonly path?: string } =>
  path === '' ? {} : { path };

export const createProvisionalApi = ({
  lease,
  terminals,
  usage,
  resources,
}: ProvisionalHosts): ProvisionalApi => {
  const projectLease = (projectId: string): LeaseHost => lease({ projectId });
  const threadLease = (threadId: string): LeaseHost => lease({ threadId });
  /** Keyboard input reaches the host in the order it was typed, per terminal. */
  const writes = new Map<string, Promise<void>>();

  const read = async <Result extends { readonly status: string }, Value>(
    projectId: string,
    call: (lease: LeaseHost) => Promise<Result>,
    ready: (result: Result) => Value,
  ): Promise<Value | Outcome> => {
    const result = await host(() => call(projectLease(projectId)));
    return result.status === 'ready' ? ready(result) : outcomeOf(result.status);
  };

  return {
    projects: {
      files: async (projectId, path) => {
        const id = identifier(projectId);
        const at = relativePath(path);
        return (await read(
          id,
          (leased) => leased.files(pathOf(at)),
          (result) => {
            const value = result as unknown as Record<string, unknown>;
            if (typeof value.path !== 'string' || !Array.isArray(value.entries))
              return invalidResponse();
            return {
              status: 'ready' as const,
              path: value.path,
              entries: value.entries.map(fileEntryFrom),
            };
          },
        )) as ProjectFilesResult;
      },
      file: async (projectId, path) => {
        const id = identifier(projectId);
        const at = relativePath(path);
        // The content route requires a path; the root sent none (422).
        if (at === '') return { status: 'invalid_path' };
        return (await read(
          id,
          (leased) => leased.file({ path: at }),
          (result) => ({
            status: 'ready' as const,
            file: fileContentFrom(result),
          }),
        )) as ProjectFileResult;
      },
      tree: async (projectId, path) => {
        const id = identifier(projectId);
        const at = relativePath(path);
        return (await read(
          id,
          (leased) => leased.tree(pathOf(at)),
          (result) => {
            const value = result as unknown as Record<string, unknown>;
            if (typeof value.path !== 'string' || !Array.isArray(value.entries))
              return invalidResponse();
            return {
              status: 'ready' as const,
              path: value.path,
              entries: value.entries.map(treeNodeFrom),
            };
          },
        )) as ProjectTreeResult;
      },
      diff: async (projectId, path) => {
        const id = identifier(projectId);
        const at = relativePath(path);
        return (await read(
          id,
          (leased) => leased.diff(pathOf(at)),
          (result) => {
            const { status: _status, ...body } = result as unknown as Record<
              string,
              unknown
            >;
            return { status: 'ready' as const, diff: diffFrom(body) };
          },
        )) as ProjectDiffResult;
      },
      changes: async (projectId, path) => {
        const id = identifier(projectId);
        const at = relativePath(path);
        return (await read(
          id,
          (leased) => leased.changes(pathOf(at)),
          (result) =>
            changesFrom(
              result as unknown as {
                readonly path?: string;
                readonly repositories: readonly unknown[];
              },
            ),
        )) as ProjectChangesResult;
      },
      fileDiff: async (projectId, repository, path) => {
        const id = identifier(projectId);
        const inRepository = relativePath(repository);
        const at = relativePath(path);
        // The route requires a non-empty path (422).
        if (at === '') return { status: 'invalid_path' };
        return (await read(
          id,
          (leased) => leased.fileDiff({ repository: inRepository, path: at }),
          (result) => fileDiffFrom((result as { readonly diff: unknown }).diff),
        )) as ProjectFileDiffResult;
      },
    },
    threads: {
      usage: async (threadId) => {
        const id = identifier(threadId);
        const value = await host(() => usage.usage(id));
        if (value === undefined) throw new Error(hostMessages.threadNotFound);
        return value as ThreadUsage;
      },
      git: async (threadId) => {
        const id = identifier(threadId);
        const result = await host(() => threadLease(id).git());
        if (result.status === 'missing') {
          throw new Error(hostMessages.threadNotFound);
        }
        if (result.status !== 'ready') {
          return {
            repo: false,
            status: result.status === 'pending' ? 'pending' : 'unavailable',
          };
        }
        return threadGitFrom(result.git);
      },
      branches: async (threadId) => {
        const id = identifier(threadId);
        const result = await host(() => threadLease(id).branches({}));
        if (result.status === 'missing') {
          throw new Error(hostMessages.threadNotFound);
        }
        if (result.status !== 'ready') {
          return blockedBranches(
            result.status === 'pending' ? 'pending' : 'unavailable',
          );
        }
        return branchesFrom(result.value);
      },
      switchBranch: async (threadId, branch, cwd) => {
        const name = branchName(branch);
        const id = identifier(threadId);
        const directory = workingDirectory(cwd);
        const result = await host(() =>
          threadLease(id).branches({ branch: name, cwd: directory }),
        );
        if (result.status === 'missing') {
          throw new Error(hostMessages.threadNotFound);
        }
        if (result.status === 'refused') throw new Error(result.message);
        if (result.status !== 'ready') {
          throw new Error(hostMessages.threadConflict);
        }
        return branchesFrom(result.value);
      },
    },
    resources: {
      host: () => host(() => resources.host()),
      project: async (projectId) => {
        const id = identifier(projectId);
        const result = await host(() => projectLease(id).resources());
        if (result.status === 'ready') {
          return {
            status: 'ready',
            container: containerResourcesFrom(result.container),
          };
        }
        return result.status === 'pending'
          ? { status: 'pending', retryAfterSeconds: 1 }
          : { status: result.status };
      },
    },
    terminals: {
      list: async (projectId) => {
        const id = identifier(projectId);
        const items = await terminalHost(() => terminals.list(id));
        return items.map(terminalFrom);
      },
      create: async (threadId) => {
        const id = identifier(threadId);
        const terminal = await terminalHost(() =>
          terminals.create({ threadId: id }),
        );
        // `undefined` is the route's 409 `terminal_unavailable`.
        if (terminal === undefined) {
          throw new Error(provisionalMessages.terminalFailed);
        }
        return terminalFrom(terminal);
      },
      snapshot: async (terminalId) => {
        const id = identifier(terminalId);
        const result = await terminalHost(() => terminals.snapshot({ id }));
        // `undefined` is the route's 404 `terminal_missing`.
        if (result === undefined) {
          throw new Error(provisionalMessages.terminalFailed);
        }
        if (
          typeof result.output !== 'string' ||
          !Number.isSafeInteger(result.offset) ||
          result.offset < result.output.length ||
          typeof result.truncated !== 'boolean'
        ) {
          throw new Error(provisionalMessages.invalidTerminalSnapshot);
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
        const write = (writes.get(id) ?? Promise.resolve())
          .catch(() => undefined)
          .then(async () => {
            // `false` is the route's 404 `terminal_missing`.
            if (
              !(await terminalHost(() => terminals.input({ id, data: text })))
            )
              throw new Error(provisionalMessages.terminalFailed);
          });
        writes.set(id, write);
        try {
          await write;
        } finally {
          if (writes.get(id) === write) writes.delete(id);
        }
      },
      resize: async (terminalId, cols, rows) => {
        const id = identifier(terminalId);
        const width = terminalDimension(cols);
        const height = terminalDimension(rows);
        if (
          !(await terminalHost(() =>
            terminals.resize({ id, cols: width, rows: height }),
          ))
        ) {
          throw new Error(provisionalMessages.terminalFailed);
        }
      },
      stop: async (terminalId) => {
        const id = identifier(terminalId);
        // The route answers 204 whether or not the terminal still existed.
        await terminalHost(() => terminals.stop(id));
      },
    },
  };
};

let current: ProvisionalApi | undefined;

/** Binds the adapter to the layout's activation services (D9-17). */
export const initProvisionalApi = (services: Services): void => {
  current = createProvisionalApi({
    lease: (scope) => services.use(RuntimeLeaseV1, scope) as RuntimeLease,
    terminals: services.use(RuntimeTerminalsV1),
    usage: services.use(RuntimeThreadsUsageV1),
    resources: services.use(ResourcesV1),
  });
};

export const disposeProvisionalApi = (): void => {
  current = undefined;
};

const bound = (): ProvisionalApi => {
  if (current === undefined) throw new Error(hostMessages.unavailable);
  return current;
};

/** The adapter the provisional components and hooks call. */
export const api: ProvisionalApi & { readonly terminals: TerminalWatchApi } = {
  projects: {
    files: (projectId, path) => bound().projects.files(projectId, path),
    file: (projectId, path) => bound().projects.file(projectId, path),
    tree: (projectId, path) => bound().projects.tree(projectId, path),
    diff: (projectId, path) => bound().projects.diff(projectId, path),
    changes: (projectId, path) => bound().projects.changes(projectId, path),
    fileDiff: (projectId, repository, path) =>
      bound().projects.fileDiff(projectId, repository, path),
  },
  threads: {
    usage: (id) => bound().threads.usage(id),
    git: (id) => bound().threads.git(id),
    branches: (id) => bound().threads.branches(id),
    switchBranch: (id, branch, cwd) =>
      bound().threads.switchBranch(id, branch, cwd),
  },
  resources: {
    host: () => bound().resources.host(),
    project: (projectId) => bound().resources.project(projectId),
  },
  terminals: {
    list: (projectId) => bound().terminals.list(projectId),
    create: (threadId) => bound().terminals.create(threadId),
    snapshot: (id) => bound().terminals.snapshot(id),
    input: (id, data) => bound().terminals.input(id, data),
    resize: (id, cols, rows) => bound().terminals.resize(id, cols, rows),
    stop: (id) => bound().terminals.stop(id),
    watchProject: (projectId, listener) =>
      watches().watchProject(projectId, listener),
    watch: (id, afterSequence, listener) =>
      watches().watch(id, afterSequence, listener),
  },
};

let watchSource: (() => TerminalWatchApi) | undefined;

/** Set by the terminal watch module; a no-op watch before activation. */
export const setTerminalWatches = (
  source: (() => TerminalWatchApi) | undefined,
): void => {
  watchSource = source;
};

const watches = (): TerminalWatchApi =>
  watchSource?.() ?? {
    watchProject: () => () => undefined,
    watch: () => () => undefined,
  };
