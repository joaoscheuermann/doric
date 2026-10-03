import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import type { Sandbox, SandboxExecInput } from 'sandbox';

import { createWorkspaceService } from '../src/lib/workspace/service.js';
import type { Thread, WorkspaceService } from '../src/lib/workspace/types.js';
import {
  deferred,
  type FakeGitProbe,
  fakeSandbox,
  pool,
  workspace,
} from './helpers/workspace.js';

/** The porcelain-v2 document of a clean repository, as Git prints it. */
const clean = [
  '# branch.oid 3dfa01783bf5ed1e051584a6a474c11a1ac8156d',
  '# branch.head main',
].join('\n');
const committed = [
  '# branch.oid 19bbd36b93d1a17a8c956fc5f0e288705e22fae6',
  '# branch.head main',
  '# branch.upstream origin/main',
  '# branch.ab +0 -1',
].join('\n');

/** Waits for a condition, so a published record is asserted without a fixed sleep. */
const until = async (condition: () => boolean): Promise<void> => {
  for (let attempt = 0; attempt < 10_000; attempt += 1) {
    if (condition()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error('The condition never held.');
};

const createThread = async (
  service: WorkspaceService,
  projectId: string,
  parentId?: string,
) => {
  const result = await service.threads.create(projectId, 'Thread', parentId);
  assert.equal(result.status, 'created');
  if (result.status !== 'created') throw new Error('Thread creation failed');
  return result.thread;
};

/**
 * A service over one scripted sandbox, with every `thread:updated` publication
 * collected so a case can assert the record it carried, and that there was
 * exactly one.
 */
const serviceAt = (
  sandbox: Sandbox,
  execute: () => Promise<string> = async () => 'done',
) => {
  const harness = workspace();
  const updated: Thread[] = [];
  const service = createWorkspaceService({
    ...harness.dependencies,
    publisher: {
      ...harness.publisher,
      threadUpdated: (value) => {
        updated.push(value);
        harness.publisher.threadUpdated(value);
      },
    },
    pool: {
      acquire: async () => ({ sandbox, release: async () => undefined }),
    } as never,
    execute,
  });
  return { harness, service, updated };
};

/**
 * A sandbox whose answers follow `current`. A Project leases a sandbox once, so
 * the only way a case can change what the host sees mid-test is to change what
 * the leased sandbox itself answers.
 */
const liveSandbox = (initial: Sandbox) => {
  const state = { current: initial };
  const handle = fakeSandbox();
  handle.exec = (input: SandboxExecInput) => state.current.exec(input);
  return { handle: handle as unknown as Sandbox, state };
};

/** One sandbox holding repository `alpha`, whose subdirectory and file hold none. */
const sandboxWithAlpha = (git: FakeGitProbe = {}) =>
  fakeSandbox({
    entries: [
      { path: 'alpha' },
      { path: 'alpha/src' },
      { path: 'alpha/README.md', content: 'x' },
    ],
    repositories: [{ path: 'alpha', git: { status: clean, ...git } }],
  });

test('refuses a directory that reads as inside the root but resolves outside it', async () => {
  // A symbolic link in the workspace pointing out of it: its lexical path is
  // inside the root, its physical one is not, and only the sandbox can see that.
  const { harness, service, updated } = serviceAt(
    fakeSandbox({
      entries: [{ path: 'alpha' }, { path: 'escape' }],
      escapes: ['escape'],
    }),
  );
  const project = await service.projects.create('Project');
  await harness.projectState(project.id, 'ready');
  const thread = await createThread(service, project.id);
  const before = await service.threads.find(thread.id);
  updated.length = 0;

  assert.deepEqual(await service.threads.setCwd(thread.id, 'escape'), {
    status: 'refused',
    change: { status: 'outside' },
  });
  assert.deepEqual(await service.threads.find(thread.id), before);
  assert.deepEqual(updated, []);

  // A directory that resolves inside the root is still accepted.
  assert.equal(
    (await service.threads.setCwd(thread.id, 'alpha')).status,
    'updated',
  );
  await service.dispose();
});

test('moves a Thread working directory, publishing the record once with its hint', async () => {
  const { harness, service, updated } = serviceAt(
    sandboxWithAlpha({ origin: 'git@github.com:owner/repo.git' }),
  );
  const project = await service.projects.create('Project');
  await harness.projectState(project.id, 'ready');
  const thread = await createThread(service, project.id);
  assert.equal((await service.threads.find(thread.id))?.cwd, '/workspace');
  updated.length = 0;

  // A relative path resolves against the current directory, the way `cd` does.
  const moved = await service.threads.setCwd(thread.id, 'alpha');
  assert.equal(moved.status, 'updated');
  if (moved.status !== 'updated') throw new Error('The move was refused');
  assert.equal(moved.thread.cwd, '/workspace/alpha');
  assert.equal(moved.thread.cwdRepo, 'github');
  assert.deepEqual(await service.threads.find(thread.id), moved.thread);
  assert.deepEqual(updated, [moved.thread]);

  // A directory inside the repository holds no marker of its own, so the hint
  // is recomputed as absent rather than left describing the parent.
  const deeper = await service.threads.setCwd(thread.id, 'src');
  assert.equal(deeper.status, 'updated');
  if (deeper.status !== 'updated') throw new Error('The move was refused');
  assert.equal(deeper.thread.cwd, '/workspace/alpha/src');
  assert.equal(deeper.thread.cwdRepo, undefined);
  assert.deepEqual(updated, [moved.thread, deeper.thread]);

  await service.dispose();
});

test('refuses a path outside the workspace, a missing one, and one that is no directory', async () => {
  const { harness, service, updated } = serviceAt(sandboxWithAlpha());
  const project = await service.projects.create('Project');
  await harness.projectState(project.id, 'ready');
  const thread = await createThread(service, project.id);
  const before = await service.threads.find(thread.id);
  updated.length = 0;

  for (const [path, status] of [
    ['/etc', 'outside'],
    ['../../etc', 'outside'],
    ['alpha/nowhere', 'missing'],
    ['alpha/README.md', 'not-directory'],
    ['/workspace/alpha/../..', 'outside'],
  ] as const) {
    assert.deepEqual(
      await service.threads.setCwd(thread.id, path),
      { status: 'refused', change: { status } },
      `expected ${status} for ${path}`,
    );
  }

  // A refusal changes nothing and publishes nothing.
  assert.deepEqual(await service.threads.find(thread.id), before);
  assert.deepEqual(updated, []);
  assert.deepEqual(await service.threads.setCwd(randomUUID(), '/workspace'), {
    status: 'missing',
  });
  await service.dispose();
});

test('refuses a move while the Project has no sandbox to resolve against', async () => {
  const harness = workspace();
  const held = deferred<unknown>();
  const service = createWorkspaceService({
    ...harness.dependencies,
    pool: { acquire: () => held.promise } as never,
    execute: async () => 'done',
  });
  const project = await service.projects.create('Project');
  const thread = await createThread(service, project.id);

  assert.deepEqual(await service.threads.setCwd(thread.id, '/workspace'), {
    status: 'inactive',
  });

  // The lease arrives afterwards; nothing about the refused move was stored.
  held.resolve({ sandbox: fakeSandbox(), release: async () => undefined });
  await service.dispose();
  assert.equal((await service.threads.find(thread.id))?.cwd, '/workspace');
});

test('starts a child in its parent working directory, as a snapshot of that moment', async () => {
  const { harness, service } = serviceAt(
    sandboxWithAlpha({ origin: 'git@github.com:owner/repo.git' }),
  );
  const project = await service.projects.create('Project');
  await harness.projectState(project.id, 'ready');
  const parent = await createThread(service, project.id);
  await service.threads.setCwd(parent.id, 'alpha');

  const child = await createThread(service, project.id, parent.id);
  assert.equal(child.cwd, '/workspace/alpha');
  assert.equal(child.cwdRepo, 'github');

  // Each Thread moves independently afterwards, and a root Thread starts at the
  // sandbox root.
  await service.threads.setCwd(parent.id, 'src');
  assert.equal((await service.threads.find(child.id))?.cwd, '/workspace/alpha');
  const sibling = await createThread(service, project.id);
  assert.equal(sibling.cwd, '/workspace');
  assert.equal(sibling.cwdRepo, undefined);
  await service.dispose();
});

test('binds each prompt to its own working directory, live across its tool calls', async () => {
  const harness = workspace();
  const seen: { cwd: string; move: unknown }[] = [];
  const service = createWorkspaceService({
    ...harness.dependencies,
    pool: pool(undefined, sandboxWithAlpha()),
    execute: async ({ host }) => {
      const before = host.workspace.cwd();
      const move = await host.workspace.setCwd('alpha');
      // The next tool call of the same prompt reads the directory it moved to.
      seen.push({ cwd: host.workspace.cwd(), move });
      const refused = await host.workspace.setCwd('nowhere');
      seen.push({ cwd: host.workspace.cwd(), move: refused });
      return `from ${before}`;
    },
  });
  const project = await service.projects.create('Project');
  await harness.projectState(project.id, 'ready');
  const thread = await createThread(service, project.id);

  const prompt = await service.threads.prompt(thread.id, 'work');
  assert.ok(prompt.status === 'accepted');
  await until(() => seen.length === 2);

  assert.deepEqual(seen, [
    {
      cwd: '/workspace/alpha',
      move: { status: 'set', cwd: '/workspace/alpha' },
    },
    {
      cwd: '/workspace/alpha',
      move: { status: 'missing' },
    },
  ]);
  assert.equal(
    (await service.threads.find(thread.id))?.cwd,
    '/workspace/alpha',
  );
  await service.dispose();
});

test('keeps a prompt working directory its own, and answers one Thread at a time', async () => {
  const { harness, service } = serviceAt(sandboxWithAlpha());
  const project = await service.projects.create('Project');
  await harness.projectState(project.id, 'ready');
  const first = await createThread(service, project.id);
  const second = await createThread(service, project.id);

  await service.threads.setCwd(first.id, 'alpha');
  const moved = await service.threads.setCwd(second.id, 'alpha/src');
  assert.equal(moved.status, 'updated');

  assert.equal((await service.threads.find(first.id))?.cwd, '/workspace/alpha');
  assert.equal(
    (await service.threads.find(second.id))?.cwd,
    '/workspace/alpha/src',
  );
  await service.dispose();
});

test('answers the Git summary of a Thread working directory', async () => {
  const { harness, service } = serviceAt(
    fakeSandbox({
      repositories: [
        {
          path: '',
          git: { status: committed, origin: 'git@github.com:owner/repo.git' },
        },
      ],
    }),
  );
  const project = await service.projects.create('Project');
  await harness.projectState(project.id, 'ready');
  const thread = await createThread(service, project.id);

  const summary = await service.threads.git(thread.id);
  assert.equal(summary.status, 'ready');
  if (summary.status !== 'ready') throw new Error('No summary');
  assert.deepEqual(summary.git, {
    repo: true,
    root: '/workspace',
    head: 'main',
    detached: false,
    unborn: false,
    upstream: 'origin/main',
    ahead: 0,
    behind: 1,
    dirty: { staged: 0, modified: 0, untracked: 0 },
    conflicted: 0,
    operation: null,
    worktree: false,
    shallow: false,
    stash: 0,
    submodules: 0,
  });
  assert.deepEqual(await service.threads.git(randomUUID()), {
    status: 'missing',
  });
  await service.dispose();
});

test('answers that a working directory holding no repository is not one', async () => {
  const { harness, service } = serviceAt(
    fakeSandbox({ entries: [{ path: 'plain/file.txt', content: 'x' }] }),
  );
  const project = await service.projects.create('Project');
  await harness.projectState(project.id, 'ready');
  const thread = await createThread(service, project.id);

  assert.deepEqual(await service.threads.git(thread.id), {
    status: 'ready',
    git: { repo: false },
  });
  await service.dispose();
});

test('probes the sandbox on every read, and publishes a hint only when it changes', async () => {
  const live = liveSandbox(fakeSandbox({ entries: [{ path: 'alpha' }] }));
  const settled = deferred();
  const { harness, service, updated } = serviceAt(live.handle, async () => {
    // The job re-origins the repository at GitHub and commits ahead of its
    // upstream, which is exactly what a settle has to notice.
    live.state.current = sandboxWithAlpha({
      status: committed,
      origin: 'git@github.com:owner/repo.git',
    });
    settled.resolve();
    return 'done';
  });
  const project = await service.projects.create('Project');
  await harness.projectState(project.id, 'ready');
  const thread = await createThread(service, project.id);

  const first = await service.threads.git(thread.id);
  assert.deepEqual(first, { status: 'ready', git: { repo: false } });

  // The sandbox moves on without the directory moving, and the very next read
  // observes it: a working directory changes under the agent while a prompt
  // runs, so a read probes rather than answering what the last read saw. Here
  // the workspace root itself becomes a repository.
  live.state.current = fakeSandbox({
    entries: [{ path: 'alpha' }, { path: 'alpha/src' }],
    repositories: [
      {
        path: '',
        git: { status: committed, origin: 'https://gitlab.com/owner/repo.git' },
      },
    ],
  });
  const second = await service.threads.git(thread.id);
  assert.ok(second.status === 'ready' && second.git.repo);
  assert.equal(second.git.root, '/workspace');

  // Moving into the repository it holds re-roots the summary, and the record's
  // hint follows the directory.
  live.state.current = sandboxWithAlpha({ status: committed });
  const moved = await service.threads.setCwd(thread.id, 'alpha');
  assert.equal(moved.status, 'updated');
  const scoped = await service.threads.git(thread.id);
  assert.ok(scoped.status === 'ready' && scoped.git.repo);
  assert.equal(scoped.git.root, '/workspace/alpha');
  assert.equal((await service.threads.find(thread.id))?.cwdRepo, 'git');

  // The job's own work becomes observable when it settles: the record's hint is
  // recomputed, so the Thread record catches up with the sandbox.
  await service.threads.prompt(thread.id, 'commit');
  await settled.promise;
  await until(() => updated.some(({ cwdRepo }) => cwdRepo === 'github'));
  assert.equal((await service.threads.find(thread.id))?.cwdRepo, 'github');
  const settledSummary = await service.threads.git(thread.id);
  assert.ok(settledSummary.status === 'ready' && settledSummary.git.repo);
  assert.equal(settledSummary.git.behind, 1);

  // Reading again finds the same hint, so nothing is published for it.
  updated.length = 0;
  await service.threads.git(thread.id);
  assert.deepEqual(updated, []);
  await service.dispose();
});
