// Public contracts of the `git` bundle (stage 10, §3.8).
//
// - `git.commands/v1` (host): a Thread's Git summary and local branches, the
//   branch switch, Discard (1.1.0), and the Project's changes, diff and one
//   file's comparison.
//   Thread reads run on the live Thread through `runtime.workspace/v1`, the
//   Project reads on the Project's current lease through `runtime.lease/v1`;
//   none acquires a lease.
// - `git.changes/v1` (client, local): the window's one changes read per
//   Project and working directory, shared with the bundles that decorate from
//   it (the files tree).
// - `git.open-comparison/v1` (client command): opens one file's comparison as
//   a workspace tab (D10-1).
//
// The schemas are written here rather than imported from `runtime/contracts`:
// a window's import map is not guaranteed to serve a host bundle's contracts
// module, and this module is loaded by the client part too.

import {
  type CallArg,
  type Disposable,
  disposableSchema,
  functionSchema,
  ref,
} from 'bundle/contracts';
import type { ReadState } from 'files/contracts';
import type { LeaseOutcome } from 'runtime/contracts';
import { z } from 'zod';

import type {
  ChangeMark,
  ProjectChangeStatus,
  ProjectChanges,
  ProjectFileChange,
  ProjectFileDiff,
  RepositoryChanges,
} from './reads.js';

export type { LeaseOutcome } from 'runtime/contracts';

export * from './reads.js';

/** The one thing a repository can be part-way through. */
export type GitOperation =
  | 'merge'
  | 'rebase'
  | 'cherry-pick'
  | 'revert'
  | 'bisect';

/** The Git summary of one Thread's working directory. */
export type ThreadGit =
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

/** One local branch of a Thread's directory. */
export interface Branch {
  readonly name: string;
  readonly current: boolean;
  readonly commit: string;
  readonly subject: string;
  readonly worktree: string;
}

/** One changed path of a repository's tracked diff. */
export interface ChangeSetEntry {
  readonly path: string;
  readonly status: Exclude<ProjectChangeStatus, 'conflicted'>;
}

/** One repository's tracked diff and the paths it changes. */
export interface ProjectChangeSet {
  readonly path: string;
  readonly diff: string;
  readonly changes: readonly ChangeSetEntry[];
}

/** One changed file of a repository, as the changes read lists it. */
export type FileChange = ProjectFileChange;

/** One changed file, HEAD against the working tree. */
export type FileDiff = ProjectFileDiff;

/** What a read on one live Thread answers. */
export type ThreadOutcome<T> =
  | { readonly status: 'ready'; readonly value: T }
  /** `missing`: no record. `inactive`: no runtime, closing or terminal. `pending`: no lease. */
  | { readonly status: 'missing' | 'inactive' | 'pending' };

/** A Thread directory's local branches, and why switching is blocked. */
export interface Branches {
  readonly branches: readonly Branch[];
  readonly blocked?: string;
}

/** A branch switch: the branches after it, or the refusal's sentence. */
export type BranchSwitch =
  | ThreadOutcome<Branches>
  | { readonly status: 'refused'; readonly message: string };

/**
 * A Discard: the targets a read after it no longer lists, the refusal's
 * sentence (nothing was written), or the first failure's sentence with the
 * targets discarded before it.
 */
export type Discard =
  | ThreadOutcome<{ readonly discarded: readonly string[] }>
  | { readonly status: 'refused'; readonly message: string }
  | {
      readonly status: 'failed';
      readonly message: string;
      readonly discarded: readonly string[];
    };

/** The changed paths of the repositories a path reaches (`GET /projects/:id/changes`). */
export type ChangesRead =
  | {
      readonly status: 'read';
      readonly path?: string;
      readonly repositories: readonly RepositoryChanges[];
    }
  | { readonly status: 'not_found' | 'invalid_path' };

/** The tracked diff of the repositories a path reaches (`GET /projects/:id/diff`). */
export type DiffRead =
  | {
      readonly status: 'read';
      readonly path?: string;
      readonly repositories: readonly ProjectChangeSet[];
    }
  | { readonly status: 'not_found' | 'invalid_path' };

/** One changed file, HEAD against the working tree (`GET /projects/:id/files/diff`). */
export type FileDiffRead =
  | { readonly status: 'read'; readonly diff: FileDiff }
  | { readonly status: 'not_found' | 'invalid_path' };

export interface Git {
  /** A Thread's Git summary; reading it refreshes the Thread's repository hint. */
  status(threadId: string, call?: CallArg): Promise<ThreadOutcome<ThreadGit>>;
  /** The local branches of a Thread's directory, under the Project lock. */
  branches(threadId: string, call?: CallArg): Promise<ThreadOutcome<Branches>>;
  /**
   * Switches a Thread's repository to an existing local branch, under the
   * Project lock. A stale `cwd`, a busy worktree and every Git refusal are
   * `refused` with the sentence the window shows.
   */
  switchBranch(
    input: {
      readonly threadId: string;
      readonly branch: string;
      readonly cwd: string;
    },
    call?: CallArg,
  ): Promise<BranchSwitch>;
  /**
   * Discards changes of one repository the Thread's working directory reads,
   * under the Project lock; not recoverable. `cwd` is the working directory the
   * Changes view read with; `repository` (sandbox-relative, `''` for the root)
   * and `paths` (repository-relative) are as the Changes read returns them.
   * Without `paths`, every listed change but nested repositories. A stale
   * `cwd`, an unlisted repository, running work in or around it, a path with
   * no change, a nested repository and a conflict are `refused`.
   */
  discard(
    input: {
      readonly threadId: string;
      readonly cwd: string;
      readonly repository: string;
      readonly paths?: readonly string[];
    },
    call?: CallArg,
  ): Promise<Discard>;
  /** The Project is `call.scope.projectId`; the Project reads never acquire. */
  changes(
    input: { readonly path?: string },
    call?: CallArg,
  ): Promise<LeaseOutcome<ChangesRead>>;
  diff(
    input: { readonly path?: string },
    call?: CallArg,
  ): Promise<LeaseOutcome<DiffRead>>;
  fileDiff(
    input: { readonly repository: string; readonly path: string },
    call?: CallArg,
  ): Promise<LeaseOutcome<FileDiffRead>>;
}

// git.changes/v1 (client, local) ---------------------------------------------

/** What the changes read of one Project and working directory shows. */
export interface ChangesObservation {
  readonly read: ReadState<ProjectChanges>;
  /** The marks of the changed paths, by workspace-relative path, for the trees that draw them. */
  readonly decorations: ReadonlyMap<string, ChangeMark>;
  /** The failed read's message, as the toast shows it. */
  readonly error?: string;
  readonly fetching: boolean;
}

/** The changes of one Project, scoped to a working directory's repositories. */
export interface ChangesScope {
  readonly projectId: string;
  /** The raw working directory; undefined is the workspace root. */
  readonly cwd?: string;
}

/** Client, local. Observing activates the read; it runs only while observed. */
export interface GitChanges {
  observe(
    scope: ChangesScope,
    listener: (state: ChangesObservation) => void,
    call?: CallArg,
  ): Disposable;
}

const changesScopeSchema = z
  .object({ projectId: z.string().min(1), cwd: z.string().optional() })
  .strict();

export const gitChangesMethods = {
  observe: {
    input: z.tuple([
      changesScopeSchema,
      functionSchema<(state: ChangesObservation) => void>(),
    ]),
    output: disposableSchema,
  },
} as const;

export const GitChangesV1 = ref<GitChanges>('git.changes/v1');

// git.open-comparison/v1 (client command) -----------------------------------

export const OPEN_COMPARISON_COMMAND = 'git.open-comparison/v1';

/** Today's diff tab key: the Project, the repository and the changed path. */
export const openComparisonInput = z
  .object({ projectId: z.string(), repository: z.string(), path: z.string() })
  .strict();

export type OpenComparisonInput = z.output<typeof openComparisonInput>;
