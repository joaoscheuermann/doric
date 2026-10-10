import { type CallArg, functionSchema, ref } from 'bundle/contracts';
import type { Sandbox } from 'sandbox';
import { z } from 'zod';

import {
  type BranchResult,
  branchResultSchema,
  type ProjectChanges,
  type ProjectDiff,
  type ProjectFile,
  type ProjectFileDiff,
  type ProjectFiles,
  type ProjectResources,
  type ProjectSsh,
  type ProjectTree,
  projectChangesSchema,
  projectDiffSchema,
  projectFileDiffSchema,
  projectFileSchema,
  projectFilesSchema,
  projectResourcesSchema,
  projectSshSchema,
  projectTreeSchema,
  type ThreadGitResult,
  threadGitResultSchema,
} from './model.js';
import { LOCAL_KEY } from './runtime.js';

/*
 * runtime.lease/v1: the sandbox operations the stage-1 tools use on the
 * sandbox leased to the calling prompt's Project (call.scope), plus, from
 * stage 5, the lease-dependent reads of the current routes (API mínima). Exec
 * carries no abort signal and returns no byte arrays.
 */

export interface LeaseExecInput {
  readonly cmd: readonly string[];
  readonly cwd?: string;
  readonly env?: readonly string[];
  readonly user?: string;
  readonly timeoutMs?: number;
  readonly tty?: boolean;
}

export interface LeaseExecResult {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

export interface LeaseDescription {
  readonly id: string;
  readonly root: string;
}

export const leaseExecInputSchema = z
  .object({
    cmd: z.array(z.string()),
    cwd: z.string().optional(),
    env: z.array(z.string()).optional(),
    user: z.string().optional(),
    timeoutMs: z.number().optional(),
    tty: z.boolean().optional(),
  })
  .strict();

export const leaseExecResultSchema = z
  .object({
    exitCode: z.number().nullable(),
    stdout: z.string(),
    stderr: z.string(),
  })
  .strict();

export const leaseDescriptionSchema: z.ZodType<
  LeaseDescription,
  LeaseDescription
> = z.looseObject({
  id: z.string(),
  root: z.string(),
});

/**
 * What a lease-dependent operation answers (1.1.0): the task's value, or why
 * the Project's lease could not run it. `unavailable` also covers a Project
 * whose closing started, or whose lease dropped, while the task ran.
 */
export type LeaseOutcome<T> =
  | { readonly status: 'ready'; readonly value: T }
  | {
      readonly status: 'pending' | 'unavailable' | 'expired' | 'missing';
    };

/** The task `withLease` runs on the leased sandbox. */
export type LeaseTask<T> = (sandbox: Sandbox) => Promise<T>;

export interface RuntimeLease {
  /** The leased sandbox's identity and workspace root. */
  describe(call?: CallArg): Promise<LeaseDescription>;
  exec(input: LeaseExecInput, call?: CallArg): Promise<LeaseExecResult>;
  readFile(path: string, call?: CallArg): Promise<string>;
  writeFile(path: string, content: string, call?: CallArg): Promise<void>;

  // Lease reads answering the current lease state without acquiring. Scope:
  // `call.scope.projectId`; a call with no Project or Thread scope rejects
  // with ContractError('invalid_input').
  ssh(call?: CallArg): Promise<ProjectSsh>;
  files(
    input: { readonly path?: string },
    call?: CallArg,
  ): Promise<ProjectFiles>;
  tree(input: { readonly path?: string }, call?: CallArg): Promise<ProjectTree>;
  file(input: { readonly path: string }, call?: CallArg): Promise<ProjectFile>;
  diff(input: { readonly path?: string }, call?: CallArg): Promise<ProjectDiff>;
  changes(
    input: { readonly path?: string },
    call?: CallArg,
  ): Promise<ProjectChanges>;
  fileDiff(
    input: { readonly repository: string; readonly path: string },
    call?: CallArg,
  ): Promise<ProjectFileDiff>;
  resources(call?: CallArg): Promise<ProjectResources>;
  // Scope: `call.scope.threadId`.
  git(call?: CallArg): Promise<ThreadGitResult>;
  /** Reads (no branch) or switches (branch and cwd echo) under the Project lock. */
  branches(
    input: { readonly branch?: string; readonly cwd?: string },
    call?: CallArg,
  ): Promise<BranchResult>;
  /**
   * 1.1.0, local only: runs `task` on the sandbox the Project of
   * `call.scope.projectId` holds now, never acquiring one. The outcome
   * follows the lease reads above: `missing` (no Project), `expired` (a
   * terminal Project without a runtime), `unavailable` (no runtime, closing,
   * or closing or lease loss during the task) and `pending` (no lease yet).
   */
  withLease<T>(task: LeaseTask<T>, call?: CallArg): Promise<LeaseOutcome<T>>;
}

/** The refusal of a lease read whose call names neither Project nor Thread. */
export const leaseScopeMessage =
  'runtime.lease/v1 needs a Project or Thread scope.';

const isObject = (value: unknown): value is object =>
  typeof value === 'object' && value !== null;

/** A `withLease` answer; its value is whatever the local task returned. */
export const leaseOutcomeSchema = z
  .custom<LeaseOutcome<unknown>>(
    (value) =>
      isObject(value) &&
      ['ready', 'pending', 'unavailable', 'expired', 'missing'].includes(
        (value as { status?: unknown }).status as string,
      ),
    { message: 'Expected a lease outcome.' },
  )
  .meta({ [LOCAL_KEY]: 'object' });

export const leaseTaskSchema = functionSchema<LeaseTask<unknown>>().meta({
  [LOCAL_KEY]: 'callback',
});

const optionalPath = z.object({ path: z.string().optional() }).strict();

export const runtimeLeaseMethods = {
  describe: { input: z.tuple([]), output: leaseDescriptionSchema },
  exec: { input: leaseExecInputSchema, output: leaseExecResultSchema },
  readFile: { input: z.string(), output: z.string() },
  writeFile: { input: z.tuple([z.string(), z.string()]), output: z.void() },
  ssh: { input: z.tuple([]), output: projectSshSchema },
  files: { input: optionalPath, output: projectFilesSchema },
  tree: { input: optionalPath, output: projectTreeSchema },
  file: {
    input: z.object({ path: z.string() }).strict(),
    output: projectFileSchema,
  },
  diff: { input: optionalPath, output: projectDiffSchema },
  changes: { input: optionalPath, output: projectChangesSchema },
  fileDiff: {
    input: z.object({ repository: z.string(), path: z.string() }).strict(),
    output: projectFileDiffSchema,
  },
  resources: { input: z.tuple([]), output: projectResourcesSchema },
  git: { input: z.tuple([]), output: threadGitResultSchema },
  branches: {
    input: z
      .object({ branch: z.string().optional(), cwd: z.string().optional() })
      .strict(),
    output: branchResultSchema,
  },
  withLease: { input: leaseTaskSchema, output: leaseOutcomeSchema },
} as const;

export const RuntimeLeaseV1 = ref<RuntimeLease>('runtime.lease/v1');
