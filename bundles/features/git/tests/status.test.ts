// git.commands/v1 `status`, a Thread's Git summary (bundle isolation 7(c),
// P3): the probe cases of the runtime's provisional `git-status` tests, which
// the step deletes, on real repositories through a fake runtime whose Thread
// works in the directory each case names.

import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, test } from 'node:test';

import { routedGit } from './support/routed-git.js';
import { fakeRuntime, repository } from './support/runtime.js';

type Repository = Awaited<ReturnType<typeof repository>>;

/** A repository whose one file `file` holds `content`, committed on `main`. */
const committed = async (
  t: Parameters<typeof repository>[0],
  content = 'initial\n',
) => {
  const repo = await repository(t);
  await writeFile(join(repo.root, 'file'), content);
  await repo.git('add', '.');
  await repo.git('commit', '-qm', 'Initial commit');
  return repo;
};

/** Commits `content` to `file` on the current branch. */
const commit = async (repo: Repository, content: string, message: string) => {
  await writeFile(join(repo.root, 'file'), content);
  await repo.git('commit', '-qam', message);
};

/** A Git command expected to stop on a conflict: its failure is the point. */
const conflicting = (repo: Repository, ...args: string[]) =>
  repo.git(...args).then(
    () => assert.fail(`git ${args.join(' ')} did not stop on a conflict`),
    () => undefined,
  );

/** The summary of a Thread working in `cwd`; fails unless it is a repository's. */
const summaryAt = async (
  t: Parameters<typeof repository>[0],
  repo: Repository,
  cwd: string,
) => {
  const { git, dispose } = routedGit(repo.sandbox, fakeRuntime({ cwd }));
  t.after(dispose);
  const read = await git({ threadId: 'thread-1' }).status('thread-1');
  assert.equal(read.status, 'ready');
  if (read.status !== 'ready') throw new Error('expected a summary');
  return read.value;
};

const repositoryAt = async (
  t: Parameters<typeof repository>[0],
  repo: Repository,
  cwd = repo.root,
) => {
  const summary = await summaryAt(t, repo, cwd);
  if (!summary.repo) throw new Error('expected a repository');
  return summary;
};

/** Two branches that change `file` differently: `feature`, then `main`. */
const diverged = async (t: Parameters<typeof repository>[0]) => {
  const repo = await committed(t);
  await repo.git('switch', '-qc', 'feature');
  await commit(repo, 'feature\n', 'Feature');
  await repo.git('switch', '-q', 'main');
  await commit(repo, 'main\n', 'Main');
  return repo;
};

describe('git.commands/v1 status', () => {
  test('summarizes a clean repository', async (t) => {
    const repo = await committed(t);

    assert.deepEqual(await summaryAt(t, repo, repo.root), {
      repo: true,
      root: repo.root,
      head: 'main',
      detached: false,
      unborn: false,
      upstream: null,
      ahead: 0,
      behind: 0,
      dirty: { staged: 0, modified: 0, untracked: 0 },
      conflicted: 0,
      operation: null,
      worktree: false,
      shallow: false,
      stash: 0,
      submodules: 0,
    });
  });

  test('reads the repository root of a directory inside one, with ahead and behind from its upstream', async (t) => {
    const repo = await committed(t);
    await repo.git('branch', 'base');
    await commit(repo, 'one\n', 'One');
    await commit(repo, 'two\n', 'Two');
    await repo.git('switch', '-q', 'base');
    await commit(repo, 'other\n', 'Other');
    await repo.git('switch', '-q', 'main');
    await repo.git('branch', '-q', '--set-upstream-to=base');
    await mkdir(join(repo.root, 'src'));

    const summary = await repositoryAt(t, repo, join(repo.root, 'src'));
    assert.equal(summary.root, repo.root);
    assert.equal(summary.upstream, 'base');
    assert.equal(summary.ahead, 2);
    assert.equal(summary.behind, 1);
  });

  test('names a detached HEAD by its short commit and an unborn repository as unborn', async (t) => {
    const repo = await committed(t);
    await repo.git('switch', '-q', '--detach');
    const short = (await repo.git('rev-parse', '--short', 'HEAD')).trim();

    const detached = await repositoryAt(t, repo);
    assert.equal(detached.head, short);
    assert.equal(detached.detached, true);
    assert.equal(detached.unborn, false);

    const fresh = await repository(t);
    const unborn = await repositoryAt(t, fresh);
    assert.equal(unborn.head, 'main');
    assert.equal(unborn.unborn, true);
    assert.equal(unborn.detached, false);
  });

  test('counts staged, modified, renamed and untracked changes', async (t) => {
    const repo = await repository(t);
    for (const name of ['a', 'b', 'c'])
      await writeFile(join(repo.root, name), `${name}\n`);
    await repo.git('add', '.');
    await repo.git('commit', '-qm', 'Initial commit');
    await writeFile(join(repo.root, 'a'), 'a staged\n');
    await repo.git('add', 'a');
    await writeFile(join(repo.root, 'b'), 'b modified\n');
    await repo.git('mv', 'c', 'renamed');
    await writeFile(join(repo.root, 'new.txt'), 'new\n');

    assert.deepEqual((await repositoryAt(t, repo)).dirty, {
      staged: 2,
      modified: 1,
      untracked: 1,
    });
  });

  test('reports a conflicted file and the merge that left it', async (t) => {
    const repo = await diverged(t);
    await conflicting(repo, 'merge', '-q', 'feature');

    const summary = await repositoryAt(t, repo);
    assert.equal(summary.conflicted, 1);
    assert.equal(summary.operation, 'merge');
  });

  test('reports a rebase, whose conflict reads as a detached HEAD', async (t) => {
    const repo = await diverged(t);
    await repo.git('switch', '-q', 'feature');
    await conflicting(repo, 'rebase', '-q', 'main');
    const short = (await repo.git('rev-parse', '--short', 'HEAD')).trim();

    const summary = await repositoryAt(t, repo);
    assert.equal(summary.operation, 'rebase');
    assert.equal(summary.detached, true);
    assert.equal(summary.head, short);
    assert.equal(summary.conflicted, 1);
  });

  test('reports a cherry-pick that stopped on a conflict', async (t) => {
    const repo = await diverged(t);
    await conflicting(repo, 'cherry-pick', 'feature');

    const summary = await repositoryAt(t, repo);
    assert.equal(summary.operation, 'cherry-pick');
    assert.equal(summary.conflicted, 1);
  });

  test('reports a linked worktree, a shallow clone and the stash count', async (t) => {
    const repo = await committed(t);
    await commit(repo, 'second\n', 'Second');
    await repo.git(
      'worktree',
      'add',
      '-qb',
      'linked',
      join(repo.root, 'linked'),
    );
    await repo.git(
      'clone',
      '-q',
      '--depth',
      '1',
      `file://${repo.root}`,
      join(repo.root, 'shallow'),
    );
    for (const content of ['first stash\n', 'second stash\n']) {
      await writeFile(join(repo.root, 'file'), content);
      await repo.git('stash', '-q');
    }

    const main = await repositoryAt(t, repo);
    assert.equal(main.worktree, false);
    assert.equal(main.shallow, false);
    assert.equal(main.stash, 2);
    assert.equal(
      (await repositoryAt(t, repo, join(repo.root, 'linked'))).worktree,
      true,
    );
    assert.equal(
      (await repositoryAt(t, repo, join(repo.root, 'shallow'))).shallow,
      true,
    );
  });

  test('counts the submodules a repository declares', async (t) => {
    const library = await committed(t);
    const repo = await committed(t);
    await repo.git(
      '-c',
      'protocol.file.allow=always',
      'submodule',
      'add',
      '-q',
      library.root,
      'library',
    );
    await repo.git('commit', '-qm', 'Add the library');

    assert.equal((await repositoryAt(t, repo)).submodules, 1);
  });

  test('answers that a directory holding no repository, or none at all, is not one', async (t) => {
    const repo = await committed(t);

    assert.deepEqual(await summaryAt(t, repo, join(repo.root, '..')), {
      repo: false,
    });
    assert.deepEqual(await summaryAt(t, repo, join(repo.root, 'missing')), {
      repo: false,
    });
  });
});
