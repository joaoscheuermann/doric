// The window's calls to `git.commands/v1` over the client → host bridge, in
// the order the old path made them (moved from the layout's provisional
// adapter, stage 9 §5.8):
//
// 1. the main process's payload guards, with their messages;
// 2. the REST route's own input check, whose 422 became a result;
// 3. the host outcome, turned into what the REST client answered for the
//    route's status (a lease state stays data, `pending` with `Retry-After: 1`;
//    a Thread without a runtime or a lease is the route's 200 body);
// 4. a failed call is an `Error` with the message the REST path showed.

import {
  type CallScope,
  isContractError,
  type Services,
} from 'bundle/contracts';
import type { ProjectLeaseState } from 'files/contracts';

import {
  type ChangesRead,
  type FileDiffRead,
  type Git,
  GitCommandsV1,
  type LeaseOutcome,
  type ProjectChangeStatus,
  type ProjectChangesResult,
  type ProjectFileChange,
  type ProjectFileDiffResult,
} from '../../contracts/index.js';
import type {
  GitBranches,
  GitOperation,
  ThreadGit,
} from '../domain/thread-git.js';

export const gitMessages = {
  unavailable: 'Doric backend is unavailable.',
  invalidResponse: 'Doric returned an invalid response.',
  /** The REST 500 envelope: any other host failure. */
  failed: 'The request could not be completed.',
  invalidIdentifier: 'The item identifier is invalid.',
  invalidPath: 'The workspace path is invalid.',
  invalidBranch: 'Invalid branch name.',
  invalidWorkingDirectory: 'The working directory is invalid.',
  threadNotFound: 'The thread was not found.',
  threadConflict: 'The thread cannot perform this operation.',
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
    throw new Error(gitMessages.invalidIdentifier);
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
    throw new Error(gitMessages.invalidPath);
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
    throw new Error(gitMessages.invalidWorkingDirectory);
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
    throw new Error(gitMessages.invalidBranch);
  }
  return value;
};

// Host calls -----------------------------------------------------------------

/** The message a failed host call shows, as the REST path showed it. */
export const hostFailure = (error: unknown): Error => {
  if (isContractError(error)) {
    if (
      error.code === 'unavailable' ||
      error.code === 'disconnected' ||
      error.code === 'generation_lost'
    ) {
      return new Error(gitMessages.unavailable);
    }
    if (error.code === 'invalid_output') {
      return new Error(gitMessages.invalidResponse);
    }
  }
  return new Error(gitMessages.failed);
};

const host = async <Value>(operation: () => Promise<Value>): Promise<Value> => {
  try {
    return await operation();
  } catch (error) {
    throw hostFailure(error);
  }
};

const invalidResponse = (): never => {
  throw new Error(gitMessages.invalidResponse);
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const wholeCount = (value: unknown): boolean =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

// Response readers -----------------------------------------------------------

type NotReady =
  | { readonly status: Exclude<ProjectLeaseState, 'pending'> }
  | { readonly status: 'pending'; readonly retryAfterSeconds: number }
  | { readonly status: 'invalid_path' | 'not_found' };

/** A lease state as the REST client read it: `pending` carried `Retry-After: 1`. */
const leaseState = (status: ProjectLeaseState): NotReady =>
  status === 'pending' ? { status, retryAfterSeconds: 1 } : { status };

/**
 * A refusal of the read itself: `not_found` was the 404
 * `project_path_not_found`; every other refusal was a 422.
 */
const refusal = (status: string): NotReady =>
  status === 'not_found' ? { status: 'not_found' } : { status: 'invalid_path' };

const changeStatuses: readonly ProjectChangeStatus[] = [
  'conflicted',
  'added',
  'modified',
  'deleted',
  'renamed',
  'untracked',
];

const fileChangeFrom = (value: unknown): ProjectFileChange => {
  if (
    !isRecord(value) ||
    typeof value.path !== 'string' ||
    !changeStatuses.includes(value.status as ProjectChangeStatus) ||
    typeof value.staged !== 'boolean' ||
    typeof value.unstaged !== 'boolean' ||
    typeof value.indexStatus !== 'string' ||
    typeof value.worktreeStatus !== 'string' ||
    (value.originalPath !== undefined && typeof value.originalPath !== 'string')
  ) {
    return invalidResponse();
  }
  return {
    path: value.path,
    status: value.status as ProjectChangeStatus,
    staged: value.staged,
    unstaged: value.unstaged,
    indexStatus: value.indexStatus,
    worktreeStatus: value.worktreeStatus,
    ...(value.originalPath === undefined
      ? {}
      : { originalPath: value.originalPath }),
  };
};

const changesFrom = (value: Record<string, unknown>): ProjectChangesResult => {
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
      ...(value.path === undefined ? {} : { path: value.path as string }),
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

// The adapter ----------------------------------------------------------------

export interface GitApi {
  /** The changes of the repositories a Project path reaches. */
  changes(projectId: string, path?: string): Promise<ProjectChangesResult>;
  /** One changed file, HEAD against the working tree. */
  fileDiff(
    projectId: string,
    repository: string,
    path: string,
  ): Promise<ProjectFileDiffResult>;
  /** A Thread's Git summary, or why its environment cannot answer. */
  git(threadId: string): Promise<ThreadGit>;
  branches(threadId: string): Promise<GitBranches>;
  switchBranch(
    threadId: string,
    branch: string,
    cwd: string,
  ): Promise<GitBranches>;
}

/** The REST query: the workspace root sent no path. */
const pathOf = (path: string): { readonly path?: string } =>
  path === '' ? {} : { path };

/** The calls over `git.commands/v1`; `git` binds a Project or Thread scope. */
export const createGitApi = (git: (scope: CallScope) => Git): GitApi => ({
  changes: async (projectId, path) => {
    const id = identifier(projectId);
    const at = relativePath(path);
    const outcome: LeaseOutcome<ChangesRead> = await host(() =>
      git({ projectId: id }).changes(pathOf(at)),
    );
    if (outcome.status !== 'ready') return leaseState(outcome.status);
    const read = outcome.value as unknown;
    if (!isRecord(read)) return invalidResponse();
    if (read.status !== 'read') return refusal(String(read.status));
    return changesFrom(read);
  },
  fileDiff: async (projectId, repository, path) => {
    const id = identifier(projectId);
    const inRepository = relativePath(repository);
    const at = relativePath(path);
    // The route requires a non-empty path (422).
    if (at === '') return { status: 'invalid_path' };
    const outcome: LeaseOutcome<FileDiffRead> = await host(() =>
      git({ projectId: id }).fileDiff({ repository: inRepository, path: at }),
    );
    if (outcome.status !== 'ready') return leaseState(outcome.status);
    const read = outcome.value as unknown;
    if (!isRecord(read)) return invalidResponse();
    if (read.status !== 'read') return refusal(String(read.status));
    return fileDiffFrom(read.diff);
  },
  git: async (threadId) => {
    const id = identifier(threadId);
    const result = await host(() => git({ threadId: id }).status(id));
    if (result.status === 'missing') {
      throw new Error(gitMessages.threadNotFound);
    }
    if (result.status !== 'ready') {
      return {
        repo: false,
        status: result.status === 'pending' ? 'pending' : 'unavailable',
      };
    }
    return threadGitFrom(result.value);
  },
  branches: async (threadId) => {
    const id = identifier(threadId);
    const result = await host(() => git({ threadId: id }).branches(id));
    if (result.status === 'missing') {
      throw new Error(gitMessages.threadNotFound);
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
      git({ threadId: id }).switchBranch({
        threadId: id,
        branch: name,
        cwd: directory,
      }),
    );
    if (result.status === 'missing') {
      throw new Error(gitMessages.threadNotFound);
    }
    if (result.status === 'refused') throw new Error(result.message);
    if (result.status !== 'ready') {
      throw new Error(gitMessages.threadConflict);
    }
    return branchesFrom(result.value);
  },
});

/** The calls bound to a part's services. */
export const gitApiOf = (services: Services): GitApi =>
  createGitApi((scope) => services.use(GitCommandsV1, scope));
