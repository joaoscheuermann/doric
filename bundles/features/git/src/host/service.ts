// git.commands/v1 (stage 10, §3.8): the Git reads and the branch switch the
// workspace window makes, moved from the runtime's `service.ts` (`git`,
// `branches`, `diff`, `changes`, `fileDiff`). Thread reads run on the live
// Thread through `runtime.workspace/v1.withThread`, Project reads on the
// Project's current lease through `runtime.lease/v1.withLease`; neither ever
// acquires a lease, and every lease or Thread state is an answer, not a
// failure.

import {
  type Call,
  defineMethod,
  defineService,
  type Services,
} from 'bundle/contracts';
import {
  RuntimeLeaseV1,
  type RuntimeTerminals,
  RuntimeWorkspaceV1,
  type ThreadContext,
} from 'runtime/contracts';
import { workspacePathKind } from 'sandbox';

import {
  type Branches,
  type BranchSwitch,
  type ChangesRead,
  type DiffRead,
  type FileDiffRead,
  GitCommandsV1,
  gitMethods,
} from '../contracts/index.js';
import { readBranches, switchBranch } from './branches.js';
import {
  projectChanges,
  readProjectChanges,
  readProjectFileDiff,
} from './changes.js';
import { threadGit } from './status.js';

/** The sentence a switch from a directory the picker no longer shows answers. */
export const staleCwdMessage =
  'The working directory changed. Reopen the branch picker and try again.';

/** The sentence a worktree with running work blocks branch switching with. */
export const busyMessage =
  'Wait for active prompts and terminal commands in this worktree to finish before switching branches.';

/** The Project's tracked terminals, while some provider lists them. */
export type TerminalList = () => Pick<RuntimeTerminals, 'list'> | undefined;

/**
 * The working directories with running work in the Thread's Project: Threads
 * with an active or queued prompt, and terminals that are not exited and are
 * either the agent's or not a manual shell.
 */
const busyPaths = async (
  thread: ThreadContext,
  terminals: TerminalList,
  call: Call,
): Promise<readonly string[]> => {
  const listed = (await terminals()?.list(thread.projectId, call)) ?? [];
  return [
    ...thread.busyCwds(),
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
  thread: ThreadContext,
  terminals: TerminalList,
  call: Call,
): Promise<string | undefined> => {
  const git = await threadGit(thread.sandbox, thread.cwd);
  const paths = await busyPaths(thread, terminals, call);
  const active = await Promise.all(
    [...new Set(paths)].map((cwd) => threadGit(thread.sandbox, cwd)),
  );
  const busy =
    git.repo && active.some((item) => item.repo && item.root === git.root);
  return busy ? busyMessage : undefined;
};

const branchesOf = async (
  thread: ThreadContext,
  terminals: TerminalList,
  call: Call,
): Promise<Branches> => {
  const blocked = await blockedByWork(thread, terminals, call);
  const value = await readBranches(thread.sandbox, thread.cwd);
  return { ...value, blocked: blocked ?? value.blocked };
};

const switchOn = async (
  thread: ThreadContext,
  branch: string,
  cwd: string,
  terminals: TerminalList,
  call: Call,
): Promise<BranchSwitch> => {
  // Holding the Project mutation lock keeps a new prompt from racing the switch.
  if (cwd !== thread.cwd)
    return { status: 'refused', message: staleCwdMessage };
  const blocked = await blockedByWork(thread, terminals, call);
  if (blocked !== undefined) return { status: 'refused', message: blocked };
  return switchBranch(thread.sandbox, thread.cwd, branch);
};

/** A path read's scope check: an escaping or missing path is a refusal. */
const scopeRefusal = async (
  sandbox: ThreadContext['sandbox'],
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

const lease = (services: Services, call: Call) =>
  services.use(RuntimeLeaseV1, call.scope);

const workspace = (services: Services, call: Call) =>
  services.use(RuntimeWorkspaceV1, call.scope);

/** `git.commands/v1`; `terminals` serves the busy check while it is available. */
export const createGitService = (terminals: TerminalList) =>
  defineService(GitCommandsV1, {
    status: defineMethod({
      expose: 'desktop',
      ...gitMethods.status,
      execute: (threadId: string, call: Call, services) =>
        workspace(services, call).withThread(
          threadId,
          { exclusive: false, refreshHint: true },
          (thread) => threadGit(thread.sandbox, thread.cwd),
          call,
        ),
    }),
    branches: defineMethod({
      expose: 'desktop',
      ...gitMethods.branches,
      execute: (threadId: string, call: Call, services) =>
        workspace(services, call).withThread(
          threadId,
          { exclusive: true },
          (thread) => branchesOf(thread, terminals, call),
          call,
        ),
    }),
    switchBranch: defineMethod({
      expose: 'desktop',
      ...gitMethods.switchBranch,
      execute: async (
        input: {
          readonly threadId: string;
          readonly branch: string;
          readonly cwd: string;
        },
        call: Call,
        services,
      ): Promise<BranchSwitch> => {
        const outcome = await workspace(services, call).withThread(
          input.threadId,
          { exclusive: true },
          (thread) =>
            switchOn(thread, input.branch, input.cwd, terminals, call),
          call,
        );
        return outcome.status === 'ready' ? outcome.value : outcome;
      },
    }),
    changes: defineMethod({
      expose: 'desktop',
      ...gitMethods.changes,
      execute: (input: { readonly path?: string }, call: Call, services) =>
        lease(services, call).withLease(
          async (sandbox): Promise<ChangesRead> =>
            (await scopeRefusal(sandbox, input.path)) ?? {
              status: 'read',
              ...(input.path === undefined ? {} : { path: input.path }),
              repositories: await readProjectChanges(sandbox, input.path),
            },
          call,
        ),
    }),
    diff: defineMethod({
      expose: 'desktop',
      ...gitMethods.diff,
      execute: (input: { readonly path?: string }, call: Call, services) =>
        lease(services, call).withLease(
          async (sandbox): Promise<DiffRead> =>
            (await scopeRefusal(sandbox, input.path)) ?? {
              status: 'read',
              ...(input.path === undefined ? {} : { path: input.path }),
              // Discovery is scoped to the requested path, so the window reads
              // the changes of one Thread's working directory, not the sandbox.
              repositories: await projectChanges(sandbox, input.path ?? ''),
            },
          call,
        ),
    }),
    fileDiff: defineMethod({
      expose: 'desktop',
      ...gitMethods.fileDiff,
      execute: async (
        input: { readonly repository: string; readonly path: string },
        call: Call,
        services,
      ) => {
        // Checked before the lease, as the route did: no lease state answers it.
        if (invalidComparison(input.repository, input.path))
          return {
            status: 'ready' as const,
            value: { status: 'invalid_path' as const },
          };
        return await lease(services, call).withLease(
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
          call,
        );
      },
    }),
  });
