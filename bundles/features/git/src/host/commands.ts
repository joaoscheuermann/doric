// `git.commands/v1`'s method bodies over `GitCommandPorts` (phase 3, S55c),
// run by the process host (`part.ts`).

import { workspacePathKind } from 'sandbox';

import type {
  Branches,
  BranchSwitch,
  ChangesRead,
  DiffRead,
  Discard,
  FileDiffRead,
  LeaseOutcome,
  ThreadGit,
  ThreadOutcome,
} from '../contracts/index.js';
import { readBranches, switchBranch } from './branches.js';
import {
  projectChanges,
  readProjectChanges,
  readProjectFileDiff,
} from './changes.js';
import { discardChanges } from './discard.js';
import type { GitCommandPorts, GitThread } from './ports.js';
import type { GitSandbox } from './sandbox.js';
import { threadGit } from './status.js';

/** The sentence a switch from a directory the picker no longer shows answers. */
export const staleCwdMessage =
  'The working directory changed. Reopen the branch picker and try again.';

/** The sentence a worktree with running work blocks branch switching with. */
export const busyMessage =
  'Wait for active prompts and terminal commands in this worktree to finish before switching branches.';

/**
 * `git.commands/v1`'s operations, without the call argument (the ports
 * carry the call). Each answers what the `Git` method answers
 * (`src/contracts/index.ts`); a Thread or lease state is an answer, never a
 * failure.
 */
export interface GitCommands {
  /** `withThread(threadId, {exclusive: false, refreshHint: true})` → the summary of the Thread's cwd. */
  status(threadId: string): Promise<ThreadOutcome<ThreadGit>>;
  /** `withThread(…, {exclusive: true})` → local branches; `blocked` is `busyMessage` when running work shares the repository. */
  branches(threadId: string): Promise<ThreadOutcome<Branches>>;
  /** Under the lock: `refused` with `staleCwdMessage`, `busyMessage` or Git's refusal sentence; else the branches after it. */
  switchBranch(input: {
    readonly threadId: string;
    readonly branch: string;
    readonly cwd: string;
  }): Promise<BranchSwitch>;
  /** Under the lock: `discardChanges` with `busy` = Threads' busy cwds + listed terminals. */
  discard(input: {
    readonly threadId: string;
    readonly cwd: string;
    readonly repository: string;
    readonly paths?: readonly string[];
  }): Promise<Discard>;
  /** On the Project lease: the scope refusal, else `{status: 'read', path?, repositories}`. */
  changes(input: {
    readonly path?: string;
  }): Promise<LeaseOutcome<ChangesRead>>;
  /** As `changes`, with the tracked diff per repository. */
  diff(input: { readonly path?: string }): Promise<LeaseOutcome<DiffRead>>;
  /** `{ready, invalid_path}` for an invalid comparison with no port call; else on the Project lease. */
  fileDiff(input: {
    readonly repository: string;
    readonly path: string;
  }): Promise<LeaseOutcome<FileDiffRead>>;
}

/**
 * The working directories with running work in the Thread's Project: Threads
 * with an active or queued prompt, and terminals that are not exited and are
 * either the agent's or not a manual shell.
 */
const busyPaths = async (
  thread: GitThread,
  ports: GitCommandPorts,
): Promise<readonly string[]> => {
  const listed = await ports.terminals(thread.projectId);
  return [
    ...(await thread.busyCwds()),
    ...listed
      .filter(
        (item) =>
          item.state !== 'exited' &&
          (item.origin === 'agent' || item.command !== 'bash'),
      )
      .map((item) => item.cwd),
  ];
};

/** Whether running work shares the Thread's repository. */
const blockedByWork = async (
  thread: GitThread,
  ports: GitCommandPorts,
): Promise<string | undefined> => {
  const git = await threadGit(thread.sandbox, thread.cwd);
  const paths = await busyPaths(thread, ports);
  const active = await Promise.all(
    [...new Set(paths)].map((cwd) => threadGit(thread.sandbox, cwd)),
  );
  const busy =
    git.repo && active.some((item) => item.repo && item.root === git.root);
  return busy ? busyMessage : undefined;
};

const branchesOf = async (
  thread: GitThread,
  ports: GitCommandPorts,
): Promise<Branches> => {
  const blocked = await blockedByWork(thread, ports);
  const value = await readBranches(thread.sandbox, thread.cwd);
  return { ...value, blocked: blocked ?? value.blocked };
};

const switchOn = async (
  thread: GitThread,
  branch: string,
  cwd: string,
  ports: GitCommandPorts,
): Promise<BranchSwitch> => {
  // Holding the Project mutation lock keeps a new prompt from racing the switch.
  if (cwd !== thread.cwd)
    return { status: 'refused', message: staleCwdMessage };
  const blocked = await blockedByWork(thread, ports);
  if (blocked !== undefined) return { status: 'refused', message: blocked };
  return switchBranch(thread.sandbox, thread.cwd, branch);
};

/** A path read's scope check: an escaping or missing path is a refusal. */
const scopeRefusal = async (
  sandbox: GitSandbox,
  path: string | undefined,
): Promise<{ readonly status: 'invalid_path' | 'not_found' } | undefined> => {
  if (path === undefined) return undefined;
  const kind = await workspacePathKind(sandbox, path);
  if (kind === 'escaped') return { status: 'invalid_path' };
  if (kind === 'missing') return { status: 'not_found' };
  return undefined;
};

/** A repository or path that names no workspace-relative file. */
const invalidComparison = (repository: string, path: string): boolean =>
  [repository, path].some(
    (value) =>
      value.includes('\0') ||
      value.startsWith('/') ||
      value.split('/').includes('..'),
  ) || path === '';

/** The operations over `ports`; makes no call until a method is called. Never throws. */
export const createGitCommands = (ports: GitCommandPorts): GitCommands => ({
  status: (threadId) =>
    ports.withThread(
      threadId,
      { exclusive: false, refreshHint: true },
      (thread) => threadGit(thread.sandbox, thread.cwd),
    ),
  branches: (threadId) =>
    ports.withThread(threadId, { exclusive: true }, (thread) =>
      branchesOf(thread, ports),
    ),
  switchBranch: async (input) => {
    const outcome = await ports.withThread(
      input.threadId,
      { exclusive: true },
      (thread) => switchOn(thread, input.branch, input.cwd, ports),
    );
    return outcome.status === 'ready' ? outcome.value : outcome;
  },
  discard: async (input) => {
    // The Project mutation lock keeps a new prompt from racing the Discard.
    const outcome = await ports.withThread(
      input.threadId,
      { exclusive: true },
      (thread) =>
        discardChanges(thread.sandbox, {
          threadCwd: thread.cwd,
          cwd: input.cwd,
          repository: input.repository,
          ...(input.paths === undefined ? {} : { paths: input.paths }),
          busy: () => busyPaths(thread, ports),
        }),
    );
    return outcome.status === 'ready' ? outcome.value : outcome;
  },
  changes: (input) =>
    ports.withProjectLease(
      async (sandbox): Promise<ChangesRead> =>
        (await scopeRefusal(sandbox, input.path)) ?? {
          status: 'read',
          ...(input.path === undefined ? {} : { path: input.path }),
          repositories: await readProjectChanges(sandbox, input.path),
        },
    ),
  diff: (input) =>
    ports.withProjectLease(
      async (sandbox): Promise<DiffRead> =>
        (await scopeRefusal(sandbox, input.path)) ?? {
          status: 'read',
          ...(input.path === undefined ? {} : { path: input.path }),
          // Discovery is scoped to the requested path, so the window reads
          // the changes of one Thread's working directory, not the sandbox.
          repositories: await projectChanges(sandbox, input.path ?? ''),
        },
    ),
  fileDiff: async (input) => {
    // Checked before the lease, as the route did: no lease state answers it.
    if (invalidComparison(input.repository, input.path))
      return { status: 'ready', value: { status: 'invalid_path' } };
    return await ports.withProjectLease(
      async (sandbox): Promise<FileDiffRead> => {
        const diff = await readProjectFileDiff(
          sandbox,
          input.repository,
          input.path,
        );
        return diff === undefined
          ? { status: 'not_found' }
          : { status: 'read', diff };
      },
    );
  },
});
