// Parity of `git.commands/v1`'s Thread methods through the router with the
// kernel service (phase 3, slice S55c, P1–P3): on the same real-git
// workspaces (twins built by one setup for the methods that change them), each
// routed answer equals the kernel's (`gitOver`) answer as the codec's rules
// encode it, and the codec's message of it passes protovalidate. P2: the
// Thread states pass through the same.

import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { promisify } from 'node:util';

import {
  BranchesResponseSchema,
  DiscardResponseSchema,
  StatusResponseSchema,
  SwitchBranchResponseSchema,
} from '../src/contracts/gen/doric/git/commands/v1/commands_pb.js';
import {
  branchesResponseOf,
  discardResponseOf,
  statusResponseOf,
  switchBranchResponseOf,
} from '../src/host/codec.js';
import { assertParity, fixGitDates } from './support/parity.js';
import {
  commandsHarness,
  type ThreadStatus,
} from './support/router-commands.js';
import {
  fakeRuntime,
  gitOver,
  localSandbox,
  repository,
} from './support/runtime.js';

fixGitDates();

const run = promisify(execFile);

type Repository = Awaited<ReturnType<typeof repository>>;

interface Workspace {
  readonly root: string;
  readonly sandbox: ReturnType<typeof localSandbox>;
}

/** The kernel service and the routed client over one workspace and Thread state. */
const pair = async (
  t: TestContext,
  workspace: Workspace,
  thread: { cwd?: string; busy?: string[]; state?: ThreadStatus } = {},
) => {
  const cwd = thread.cwd ?? workspace.root;
  const kernel = gitOver(
    workspace.sandbox,
    fakeRuntime({
      cwd,
      busy: thread.busy ?? [],
      thread: thread.state ?? 'ready',
    }),
  );
  t.after(kernel.dispose);
  const h = commandsHarness({
    sandbox: workspace.sandbox,
    state: {
      cwd,
      busyCwds: thread.busy ?? [],
      thread: thread.state ?? 'ready',
    },
  });
  t.after(() => h.router.control.stop());
  await h.activate();
  return {
    kernel: kernel.git({ projectId: 'project-1', threadId: 'thread-1' }),
    routed: h.client(),
  };
};

const write = async (root: string, path: string, content: string) => {
  await mkdir(dirname(join(root, path)), { recursive: true });
  await writeFile(join(root, path), content);
};

/** A repository with `files` committed on `main`. */
const committed = async (
  t: TestContext,
  files: Record<string, string> = { 'a.txt': 'a\n', 'b.txt': 'b\n' },
): Promise<Repository> => {
  const repo = await repository(t);
  for (const [path, content] of Object.entries(files))
    await write(repo.root, path, content);
  await repo.git('add', '-A');
  await repo.git('commit', '-qm', 'Initial commit');
  return repo;
};

/** A directory that is not a repository. */
const plainDirectory = async (t: TestContext): Promise<Workspace> => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'doric-plain-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, sandbox: localSandbox(root) };
};

/** `a.txt` changed differently on `other` and `main`, merged: a conflict. */
const conflicted = async (repo: Repository) => {
  await repo.git('switch', '-qc', 'other');
  await write(repo.root, 'a.txt', 'other\n');
  await repo.git('commit', '-qam', 'Other');
  await repo.git('switch', '-q', 'main');
  await write(repo.root, 'a.txt', 'main\n');
  await repo.git('commit', '-qam', 'Main');
  await repo.git('merge', 'other').catch(() => undefined);
};

void test('P1/P3: Status of no repository, clean, dirty, detached, unborn and a merge in progress', async (t) => {
  const cases: [string, (t: TestContext) => Promise<Workspace>][] = [
    ['no repository', plainDirectory],
    ['clean', (t) => committed(t)],
    [
      'dirty',
      async (t) => {
        const repo = await committed(t);
        await write(repo.root, 'a.txt', 'edited\n');
        await write(repo.root, 'staged.txt', 'staged\n');
        await repo.git('add', 'staged.txt');
        await write(repo.root, 'u.txt', 'untracked\n');
        return repo;
      },
    ],
    [
      'detached',
      async (t) => {
        const repo = await committed(t);
        await repo.git('switch', '-q', '--detach');
        return repo;
      },
    ],
    ['unborn', (t) => repository(t)],
    [
      'merge in progress',
      async (t) => {
        const repo = await committed(t);
        await conflicted(repo);
        return repo;
      },
    ],
  ];
  for (const [label, setup] of cases) {
    const workspace = await setup(t);
    const { kernel, routed } = await pair(t, workspace);
    assertParity({
      label: `Status ${label}`,
      schema: StatusResponseSchema,
      kernel: await kernel.status('thread-1'),
      routed: await routed.status({ threadId: 'thread-1' }),
      codec: statusResponseOf,
    });
  }
});

void test('P1/P3: Branches of a repository, a non-repository cwd, a cwd outside the workspace, and a busy repository', async (t) => {
  const repo = await committed(t);
  await repo.git('branch', 'feature');
  const plain = await plainDirectory(t);
  const cases: [string, Workspace, { cwd?: string; busy?: string[] }][] = [
    ['repository', repo, {}],
    ['non-repository', plain, {}],
    ['outside the workspace', repo, { cwd: dirname(repo.root) }],
    ['busy', repo, { busy: [repo.root] }],
  ];
  for (const [label, workspace, thread] of cases) {
    const { kernel, routed } = await pair(t, workspace, thread);
    assertParity({
      label: `Branches ${label}`,
      schema: BranchesResponseSchema,
      kernel: await kernel.branches('thread-1'),
      routed: await routed.branches({ threadId: 'thread-1' }),
      codec: branchesResponseOf,
    });
  }
});

/** A repository with a linked worktree, a conflicting `feature`, a clean `plain`, and local edits. */
const switchable = async (t: TestContext): Promise<Repository> => {
  const repo = await committed(t);
  await repo.git('worktree', 'add', '-qb', 'linked', join(repo.root, 'linked'));
  await repo.git('branch', 'plain');
  await repo.git('switch', '-qc', 'feature');
  await write(repo.root, 'a.txt', 'feature\n');
  await repo.git('commit', '-qam', 'Feature');
  await repo.git('switch', '-q', 'main');
  await write(repo.root, 'a.txt', 'local edits\n');
  return repo;
};

void test('P1/P3: SwitchBranch checked out in another worktree, missing, conflicting, then switched, on twin workspaces', async (t) => {
  const [kernelRepo, routedRepo] = [await switchable(t), await switchable(t)];
  const kernelSide = await pair(t, kernelRepo);
  const routedSide = await pair(t, routedRepo);

  for (const branch of ['linked', 'nope', 'feature', 'plain']) {
    assertParity({
      label: `SwitchBranch ${branch}`,
      schema: SwitchBranchResponseSchema,
      kernel: await kernelSide.kernel.switchBranch({
        threadId: 'thread-1',
        branch,
        cwd: kernelRepo.root,
      }),
      routed: await routedSide.routed.switchBranch({
        threadId: 'thread-1',
        branch,
        cwd: routedRepo.root,
      }),
      codec: switchBranchResponseOf,
      roots: { kernel: kernelRepo.root, routed: routedRepo.root },
    });
  }
});

interface DiscardCase {
  readonly label: string;
  /** Changes the committed `a.txt`/`b.txt` repository. */
  readonly setup: (repo: Repository) => Promise<void>;
  readonly cwd?: (root: string) => string;
  readonly repository?: string;
  /** Absent: Discard all. */
  readonly paths?: readonly string[];
  readonly busy?: boolean;
}

const edited = async (repo: Repository) => {
  await write(repo.root, 'a.txt', 'edited\n');
  await write(repo.root, 'b.txt', 'edited\n');
  await write(repo.root, 'u.txt', 'untracked\n');
};

const discardCases: readonly DiscardCase[] = [
  { label: 'stale cwd', setup: edited, cwd: (root) => join(root, 'other') },
  {
    label: 'unlisted repository',
    setup: edited,
    repository: 'nope',
    paths: ['a.txt'],
  },
  { label: 'busy', setup: edited, busy: true },
  {
    label: 'path with no change',
    setup: async (repo) => write(repo.root, 'a.txt', 'edited\n'),
    paths: ['b.txt'],
  },
  {
    label: 'nested repository',
    setup: async (repo) => {
      const nested = join(repo.root, 'nested');
      await write(nested, 'n.txt', 'n\n');
      const git = (...args: string[]) => run('git', ['-C', nested, ...args]);
      await git('init', '-q', '-b', 'main');
      await git('add', '-A');
      await git(
        '-c',
        'user.name=Test',
        '-c',
        'user.email=t@e.st',
        'commit',
        '-qm',
        'n',
      );
      await write(nested, 'n.txt', 'edited\n');
    },
    paths: ['nested'],
  },
  { label: 'conflict', setup: conflicted, paths: ['a.txt'] },
  {
    label: 'a failing command',
    setup: async (repo) => {
      await edited(repo);
      await writeFile(join(repo.root, '.git', 'index.lock'), '');
    },
    paths: ['u.txt', 'a.txt', 'b.txt'],
  },
  { label: 'all', setup: edited },
];

void test('P1/P3: Discard refusals and effects on twin workspaces', async (t) => {
  for (const c of discardCases) {
    const twins: Repository[] = [];
    for (const _ of [0, 1]) {
      const repo = await committed(t);
      await c.setup(repo);
      twins.push(repo);
    }
    const [kernelRepo, routedRepo] = twins as [Repository, Repository];
    const kernelSide = await pair(t, kernelRepo, {
      busy: c.busy ? [kernelRepo.root] : [],
    });
    const routedSide = await pair(t, routedRepo, {
      busy: c.busy ? [routedRepo.root] : [],
    });
    const cwdOf = (root: string) => c.cwd?.(root) ?? root;

    assertParity({
      label: `Discard ${c.label}`,
      schema: DiscardResponseSchema,
      kernel: await kernelSide.kernel.discard({
        threadId: 'thread-1',
        cwd: cwdOf(kernelRepo.root),
        repository: c.repository ?? '',
        ...(c.paths === undefined ? {} : { paths: c.paths }),
      }),
      routed: await routedSide.routed.discard({
        threadId: 'thread-1',
        cwd: cwdOf(routedRepo.root),
        repository: c.repository ?? '',
        paths: [...(c.paths ?? [])],
        all: c.paths === undefined,
      }),
      codec: discardResponseOf,
      roots: { kernel: kernelRepo.root, routed: routedRepo.root },
    });
  }
});

void test('P2: each Thread state passes through every Thread method as the kernel answers it', async (t) => {
  const repo = await committed(t);
  for (const state of ['missing', 'inactive', 'pending'] as const) {
    const { kernel, routed } = await pair(t, repo, { state });
    const input = { threadId: 'thread-1', cwd: repo.root };
    assertParity({
      label: `Status ${state}`,
      schema: StatusResponseSchema,
      kernel: await kernel.status('thread-1'),
      routed: await routed.status({ threadId: 'thread-1' }),
      codec: statusResponseOf,
    });
    assertParity({
      label: `Branches ${state}`,
      schema: BranchesResponseSchema,
      kernel: await kernel.branches('thread-1'),
      routed: await routed.branches({ threadId: 'thread-1' }),
      codec: branchesResponseOf,
    });
    assertParity({
      label: `SwitchBranch ${state}`,
      schema: SwitchBranchResponseSchema,
      kernel: await kernel.switchBranch({ ...input, branch: 'main' }),
      routed: await routed.switchBranch({ ...input, branch: 'main' }),
      codec: switchBranchResponseOf,
    });
    assertParity({
      label: `Discard ${state}`,
      schema: DiscardResponseSchema,
      kernel: await kernel.discard({ ...input, repository: '' }),
      routed: await routed.discard({ ...input, repository: '', all: true }),
      codec: discardResponseOf,
    });
  }
});
