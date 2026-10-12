// git.commands/v1 Thread reads (stage 10, §3.8; ported from the runtime's
// provisional branches and git-status tests): the local branches of a
// Thread's directory and the branch switch, on a real repository, through a
// fake runtime whose Thread is live or in one of its other states. The
// switch's refusals are the sentences the window shows.

import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, test } from 'node:test';

import {
  fakeRuntime,
  gitOver,
  repository,
  terminal,
} from './support/runtime.js';

const busy =
  'Wait for active prompts and terminal commands in this worktree to finish before switching branches.';

const committed = async (t: Parameters<typeof repository>[0]) => {
  const repo = await repository(t);
  await writeFile(join(repo.root, 'file'), 'initial\n');
  await repo.git('add', '.');
  await repo.git('commit', '-qm', 'Initial commit');
  return repo;
};

const current = async (repo: Awaited<ReturnType<typeof repository>>) =>
  (await repo.git('branch', '--show-current')).trim();

describe('git.commands/v1 branches', () => {
  test('lists local branches and switches while keeping unrelated changes', async (t) => {
    const repo = await committed(t);
    await repo.git('branch', 'feature');
    await writeFile(join(repo.root, 'new'), 'keep me');
    const runtime = fakeRuntime({ cwd: repo.root });
    const { git, dispose } = gitOver(repo.sandbox, runtime);
    t.after(dispose);
    const thread = git({ threadId: 'thread-1' });

    const read = await thread.branches('thread-1');
    assert.equal(read.status, 'ready');
    if (read.status !== 'ready') return;
    assert.equal(read.value.blocked, undefined);
    assert.equal(
      read.value.branches.find((branch) => branch.current)?.name,
      'main',
    );
    assert.equal(
      read.value.branches.find((branch) => branch.name === 'feature')?.subject,
      'Initial commit',
    );

    const switched = await thread.switchBranch({
      threadId: 'thread-1',
      branch: 'feature',
      cwd: repo.root,
    });
    assert.equal(switched.status, 'ready');
    if (switched.status !== 'ready') return;
    assert.equal(
      switched.value.branches.find((branch) => branch.current)?.name,
      'feature',
    );
    assert.equal(await current(repo), 'feature');
    assert.equal(await readFile(join(repo.root, 'new'), 'utf8'), 'keep me');
  });

  test('refuses a switch from a working directory the picker no longer shows', async (t) => {
    const repo = await committed(t);
    await repo.git('branch', 'feature');
    const { git, dispose } = gitOver(
      repo.sandbox,
      fakeRuntime({ cwd: repo.root }),
    );
    t.after(dispose);

    assert.deepEqual(
      await git({ threadId: 'thread-1' }).switchBranch({
        threadId: 'thread-1',
        branch: 'feature',
        cwd: join(repo.root, 'elsewhere'),
      }),
      {
        status: 'refused',
        message:
          'The working directory changed. Reopen the branch picker and try again.',
      },
    );
    assert.equal(await current(repo), 'main');
  });

  test('refuses each switch Git cannot make safely, with its sentence', async (t) => {
    const repo = await committed(t);
    await repo.git(
      'worktree',
      'add',
      '-qb',
      'linked',
      join(repo.root, 'linked'),
    );
    await repo.git('switch', '-qc', 'feature');
    await writeFile(join(repo.root, 'file'), 'feature\n');
    await repo.git('commit', '-qam', 'Feature');
    await repo.git('switch', '-q', 'main');
    await writeFile(join(repo.root, 'file'), 'local edits\n');
    const { git, dispose } = gitOver(
      repo.sandbox,
      fakeRuntime({ cwd: repo.root }),
    );
    t.after(dispose);
    const switchTo = (branch: string) =>
      git({ threadId: 'thread-1' }).switchBranch({
        threadId: 'thread-1',
        branch,
        cwd: repo.root,
      });

    assert.deepEqual(await switchTo('linked'), {
      status: 'refused',
      message: 'This branch is checked out in another worktree.',
    });
    assert.deepEqual(await switchTo('main; touch injected'), {
      status: 'refused',
      message: 'This local branch no longer exists.',
    });
    assert.deepEqual(await switchTo('feature'), {
      status: 'refused',
      message:
        'Git could not switch branches. Commit or stash conflicting local changes and try again.',
    });
    assert.equal(
      await readFile(join(repo.root, 'file'), 'utf8'),
      'local edits\n',
    );
    assert.equal(await repo.git('stash', 'list'), '');
    assert.equal(await current(repo), 'main');
  });

  test('blocks switching outside a repository and during a Git operation', async (t) => {
    const repo = await committed(t);
    const outside = gitOver(
      repo.sandbox,
      fakeRuntime({ cwd: join(repo.root, '..') }),
    );
    t.after(outside.dispose);
    const outsideRead = await outside.git({}).branches('thread-1');
    assert.deepEqual(outsideRead, {
      status: 'ready',
      value: {
        branches: [],
        blocked: 'The working directory must stay inside the workspace.',
      },
    });

    // A merge in progress: MERGE_HEAD marks it.
    const head = (await repo.git('rev-parse', 'HEAD')).trim();
    await writeFile(join(repo.root, '.git', 'MERGE_HEAD'), `${head}\n`);
    const merging = gitOver(repo.sandbox, fakeRuntime({ cwd: repo.root }));
    t.after(merging.dispose);
    const blocked =
      'Finish the current Git operation and resolve conflicts before switching branches.';
    const read = await merging.git({}).branches('thread-1');
    assert.equal(read.status === 'ready' && read.value.blocked, blocked);
    assert.deepEqual(
      await merging.git({}).switchBranch({
        threadId: 'thread-1',
        branch: 'main',
        cwd: repo.root,
      }),
      { status: 'refused', message: blocked },
    );
  });

  test('blocks switching while running work shares the repository', async (t) => {
    const repo = await committed(t);
    await repo.git('branch', 'feature');
    await mkdir(join(repo.root, 'src'));
    const cases = [
      // A Thread with an active or queued prompt in a directory of the repository.
      { busy: [join(repo.root, 'src')], terminals: undefined, blocked: true },
      // The agent's terminal, and a user terminal running a command.
      {
        busy: [],
        terminals: [
          terminal({ origin: 'agent', command: 'bash', cwd: repo.root }),
        ],
        blocked: true,
      },
      {
        busy: [],
        terminals: [
          terminal({ origin: 'user', command: 'npm run dev', cwd: repo.root }),
        ],
        blocked: true,
      },
      // A manual shell, and any exited terminal, do not hold the worktree.
      {
        busy: [],
        terminals: [
          terminal({ origin: 'user', command: 'bash', cwd: repo.root }),
          terminal({ id: 't-2', state: 'exited', cwd: repo.root }),
        ],
        blocked: false,
      },
      // Work in a directory outside every repository does not either.
      { busy: [join(repo.root, '..')], terminals: [], blocked: false },
    ];

    for (const { busy: paths, terminals, blocked } of cases) {
      const { git, dispose } = gitOver(
        repo.sandbox,
        fakeRuntime({ cwd: repo.root, busy: paths, terminals }),
      );
      t.after(dispose);
      const read = await git({}).branches('thread-1');
      assert.equal(read.status, 'ready');
      assert.equal(
        read.status === 'ready' ? read.value.blocked : undefined,
        blocked ? busy : undefined,
        JSON.stringify({ paths, terminals }),
      );
      const switched = await git({}).switchBranch({
        threadId: 'thread-1',
        branch: 'feature',
        cwd: repo.root,
      });
      assert.deepEqual(
        switched.status === 'refused' ? switched.message : switched.status,
        blocked ? busy : 'ready',
      );
      if (!blocked) await repo.git('switch', '-q', 'main');
    }
  });

  test('passes a Thread that is gone, closing or waiting for its sandbox through as data', async (t) => {
    const repo = await committed(t);
    for (const state of ['missing', 'inactive', 'pending'] as const) {
      const { git, dispose } = gitOver(
        repo.sandbox,
        fakeRuntime({ thread: state, cwd: repo.root }),
      );
      t.after(dispose);
      const thread = git({ threadId: 'thread-1' });
      assert.deepEqual(await thread.status('thread-1'), { status: state });
      assert.deepEqual(await thread.branches('thread-1'), { status: state });
      assert.deepEqual(
        await thread.switchBranch({
          threadId: 'thread-1',
          branch: 'main',
          cwd: repo.root,
        }),
        { status: state },
      );
    }
  });

  test('reads and switches under the Project lock; the summary refreshes the hint', async (t) => {
    const repo = await committed(t);
    const runtime = fakeRuntime({ cwd: repo.root });
    const { git, dispose } = gitOver(repo.sandbox, runtime);
    t.after(dispose);

    await git({}).status('thread-1');
    await git({}).branches('thread-1');
    await git({}).switchBranch({
      threadId: 'thread-1',
      branch: 'main',
      cwd: repo.root,
    });
    assert.deepEqual(
      runtime.threads.map(({ options }) => ({
        exclusive: options.exclusive,
        refreshHint: options.refreshHint === true,
      })),
      [
        { exclusive: false, refreshHint: true },
        { exclusive: true, refreshHint: false },
        { exclusive: true, refreshHint: false },
      ],
    );
  });
});
