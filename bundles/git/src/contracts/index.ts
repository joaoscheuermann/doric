// Public contracts of the `git` bundle (stage 10, §3.8).
//
// - `git.commands/v1` (host): a Thread's Git summary and local branches, the
//   branch switch, and the Project's changes, diff and one file's comparison.
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
import type { ProjectChanges, ReadState } from 'desktop-reads';
import type {
  Branch,
  FileDiff,
  LeaseOutcome,
  ProjectChangeSet,
  RepositoryChanges,
  ThreadGit,
} from 'runtime/contracts';
import { z } from 'zod';

export type {
  Branch,
  FileChange,
  FileDiff,
  LeaseOutcome,
  ProjectChangeSet,
  RepositoryChanges,
  ThreadGit,
} from 'runtime/contracts';

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

// Schemas ---------------------------------------------------------------------

const threadGitSchema: z.ZodType<ThreadGit, ThreadGit> = z.union([
  z.looseObject({ repo: z.literal(false) }),
  z.looseObject({
    repo: z.literal(true),
    root: z.string(),
    head: z.string(),
    detached: z.boolean(),
    unborn: z.boolean(),
    upstream: z.string().nullable(),
    ahead: z.number(),
    behind: z.number(),
    dirty: z.looseObject({
      staged: z.number(),
      modified: z.number(),
      untracked: z.number(),
    }),
    conflicted: z.number(),
    operation: z
      .enum(['merge', 'rebase', 'cherry-pick', 'revert', 'bisect'])
      .nullable(),
    worktree: z.boolean(),
    shallow: z.boolean(),
    stash: z.number(),
    submodules: z.number(),
  }),
]);

const branchesSchema: z.ZodType<Branches, Branches> = z.looseObject({
  branches: z.array(
    z.looseObject({
      name: z.string(),
      current: z.boolean(),
      commit: z.string(),
      subject: z.string(),
      worktree: z.string(),
    }),
  ),
  blocked: z.string().optional(),
});

const threadStates = z.looseObject({
  status: z.enum(['missing', 'inactive', 'pending']),
});

const leaseStates = z.looseObject({
  status: z.enum(['pending', 'unavailable', 'expired', 'missing']),
});

const ready = <T extends z.ZodType>(value: T) =>
  z.looseObject({ status: z.literal('ready'), value });

const readRefusal = z.looseObject({
  status: z.enum(['not_found', 'invalid_path']),
});

const fileChangeShape = {
  path: z.string(),
  originalPath: z.string().optional(),
  status: z.enum([
    'added',
    'modified',
    'deleted',
    'renamed',
    'untracked',
    'conflicted',
  ]),
  staged: z.boolean(),
  unstaged: z.boolean(),
  indexStatus: z.string(),
  worktreeStatus: z.string(),
};

const changesReadSchema = z.union([
  z.looseObject({
    status: z.literal('read'),
    path: z.string().optional(),
    repositories: z.array(
      z.looseObject({
        path: z.string(),
        changes: z.array(z.looseObject(fileChangeShape)),
        added: z.number(),
        removed: z.number(),
      }),
    ),
  }),
  readRefusal,
]);

const diffReadSchema = z.union([
  z.looseObject({
    status: z.literal('read'),
    path: z.string().optional(),
    repositories: z.array(
      z.looseObject({
        path: z.string(),
        diff: z.string(),
        changes: z.array(
          z.looseObject({
            path: z.string(),
            status: z.enum([
              'added',
              'modified',
              'deleted',
              'renamed',
              'untracked',
            ]),
          }),
        ),
      }),
    ),
  }),
  readRefusal,
]);

const fileDiffReadSchema = z.union([
  z.looseObject({
    status: z.literal('read'),
    diff: z.looseObject({
      ...fileChangeShape,
      repository: z.string(),
      original: z.string(),
      modified: z.string(),
      binary: z.boolean(),
      truncated: z.boolean(),
    }),
  }),
  readRefusal,
]);

const optionalPath = z.object({ path: z.string().optional() }).strict();

export const gitMethods = {
  status: {
    input: z.string(),
    output: z.union([ready(threadGitSchema), threadStates]) as z.ZodType<
      ThreadOutcome<ThreadGit>,
      ThreadOutcome<ThreadGit>
    >,
  },
  branches: {
    input: z.string(),
    output: z.union([ready(branchesSchema), threadStates]) as z.ZodType<
      ThreadOutcome<Branches>,
      ThreadOutcome<Branches>
    >,
  },
  switchBranch: {
    input: z
      .object({ threadId: z.string(), branch: z.string(), cwd: z.string() })
      .strict(),
    output: z.union([
      ready(branchesSchema),
      z.looseObject({ status: z.literal('refused'), message: z.string() }),
      threadStates,
    ]) as z.ZodType<BranchSwitch, BranchSwitch>,
  },
  changes: {
    input: optionalPath,
    output: z.union([ready(changesReadSchema), leaseStates]) as z.ZodType<
      LeaseOutcome<ChangesRead>,
      LeaseOutcome<ChangesRead>
    >,
  },
  diff: {
    input: optionalPath,
    output: z.union([ready(diffReadSchema), leaseStates]) as z.ZodType<
      LeaseOutcome<DiffRead>,
      LeaseOutcome<DiffRead>
    >,
  },
  fileDiff: {
    input: z.object({ repository: z.string(), path: z.string() }).strict(),
    output: z.union([ready(fileDiffReadSchema), leaseStates]) as z.ZodType<
      LeaseOutcome<FileDiffRead>,
      LeaseOutcome<FileDiffRead>
    >,
  },
} as const;

export const GitCommandsV1 = ref<Git>('git.commands/v1');

// git.changes/v1 (client, local) ---------------------------------------------

/** What the changes read of one Project and working directory shows. */
export interface ChangesObservation {
  readonly read: ReadState<ProjectChanges>;
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
