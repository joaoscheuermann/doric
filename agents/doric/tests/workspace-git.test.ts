import assert from 'node:assert/strict';
import test from 'node:test';

import { cwdRepoHint, threadGit } from '../src/lib/workspace/git-status.js';
import { type FakeGitProbe, fakeSandbox } from './helpers/workspace.js';

/**
 * The porcelain-v2 documents below are what Git itself printed in a scratch
 * repository, so the parse is measured against the real protocol rather than
 * against an interpretation of it.
 */
const clean = [
  '# branch.oid 3dfa01783bf5ed1e051584a6a474c11a1ac8156d',
  '# branch.head main',
].join('\n');
const ahead = [
  '# branch.oid e6de3796239343c5d26b373af728030a256a2660',
  '# branch.head main',
  '# branch.upstream origin/main',
  '# branch.ab +1 -2',
].join('\n');
const detached = [
  '# branch.oid 19bbd36b93d1a17a8c956fc5f0e288705e22fae6',
  '# branch.head (detached)',
].join('\n');
const unborn = ['# branch.oid (initial)', '# branch.head main'].join('\n');
const dirty = [
  '# branch.oid 35a840ac63408f9e9e0319521d94b0afdbb008db',
  '# branch.head main',
  '1 M. N... 100644 100644 100644 422c2b7ab3b3c668038da977e4e93a5fc623169c 55dce135f5939fc45738aec42a917794a39cbfce a',
  '1 .M N... 100644 100644 100644 f2ad6c76f0115a6ba5b00456a849810e7ec0af20 f2ad6c76f0115a6ba5b00456a849810e7ec0af20 c',
  '2 R. N... 100644 100644 100644 f2ad6c76f0115a6ba5b00456a849810e7ec0af20 416ff4c226b3d4bdea5461b3d14076ffcfd71321 R50 c2\tc',
  '? new.txt',
].join('\n');
const conflicted = [
  '# branch.oid 9e6320611e88df8195193c42be06b34bb259068a',
  '# branch.head main',
  'u UU N... 100644 100644 100644 100644 78981922613b2afb6025042ff6bd878ac1994e85 37622491df3f4aa9c9d05a03275ae5d5f5263bef ab7768987ce64e0490e93767ca9a4bcd950c79f6 a',
].join('\n');
/** A rebase detaches HEAD, which is why its conflict reads as detached. */
const rebasing = [
  '# branch.oid 65518d4b0b878e0baca6a2db7b672de26d248d65',
  '# branch.head (detached)',
  'u UU N... 100644 100644 100644 100644 78981922613b2afb6025042ff6bd878ac1994e85 37622491df3f4aa9c9d05a03275ae5d5f5263bef ab7768987ce64e0490e93767ca9a4bcd950c79f6 a',
].join('\n');

/** A sandbox whose repository `alpha`, with a subdirectory, answers this probe. */
const repositoryAt = (git: FakeGitProbe) =>
  fakeSandbox({
    entries: [{ path: 'alpha' }, { path: 'alpha/src' }],
    repositories: [{ path: 'alpha', git }],
  });

test('summarizes a clean repository from its porcelain-v2 headers', async () => {
  assert.deepEqual(
    await threadGit(repositoryAt({ status: clean }), '/workspace/alpha'),
    {
      repo: true,
      root: '/workspace/alpha',
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
    },
  );
});

test('reads the repository root of a directory inside one, with ahead and behind from its upstream', async () => {
  assert.deepEqual(
    await threadGit(repositoryAt({ status: ahead }), '/workspace/alpha/src'),
    {
      repo: true,
      root: '/workspace/alpha',
      head: 'main',
      detached: false,
      unborn: false,
      upstream: 'origin/main',
      ahead: 1,
      behind: 2,
      dirty: { staged: 0, modified: 0, untracked: 0 },
      conflicted: 0,
      operation: null,
      worktree: false,
      shallow: false,
      stash: 0,
      submodules: 0,
    },
  );
});

test('names a detached HEAD by its short commit and an unborn repository as unborn', async () => {
  const detachedHead = await threadGit(
    repositoryAt({ status: detached, short: '19bbd36' }),
    '/workspace/alpha',
  );
  assert.ok(detachedHead.repo);
  assert.equal(detachedHead.head, '19bbd36');
  assert.equal(detachedHead.detached, true);
  assert.equal(detachedHead.unborn, false);

  const fresh = await threadGit(
    fakeSandbox({ repositories: [{ path: 'fresh', git: { status: unborn } }] }),
    '/workspace/fresh',
  );
  assert.ok(fresh.repo);
  assert.equal(fresh.head, 'main');
  assert.equal(fresh.unborn, true);
  assert.equal(fresh.detached, false);
});

test('counts staged, modified, renamed and untracked records', async () => {
  const summary = await threadGit(
    repositoryAt({ status: dirty }),
    '/workspace/alpha',
  );
  assert.ok(summary.repo);
  assert.deepEqual(summary.dirty, { staged: 2, modified: 1, untracked: 1 });
});

test('reports an unmerged record and the operation that left it', async () => {
  const merge = await threadGit(
    repositoryAt({ status: conflicted, operation: 'merge' }),
    '/workspace/alpha',
  );
  assert.ok(merge.repo);
  assert.equal(merge.conflicted, 1);
  assert.equal(merge.operation, 'merge');

  const rebase = await threadGit(
    repositoryAt({ status: rebasing, operation: 'rebase', short: '65518d4' }),
    '/workspace/alpha',
  );
  assert.ok(rebase.repo);
  assert.equal(rebase.operation, 'rebase');
  assert.equal(rebase.detached, true);
  assert.equal(rebase.head, '65518d4');

  const picking = await threadGit(
    repositoryAt({ status: conflicted, operation: 'cherry-pick' }),
    '/workspace/alpha',
  );
  assert.ok(picking.repo);
  assert.equal(picking.operation, 'cherry-pick');
});

test('reports a linked worktree, a shallow clone, and the stash count', async () => {
  const summary = await threadGit(
    repositoryAt({ status: clean, worktree: true, shallow: true, stash: 2 }),
    '/workspace/alpha',
  );
  assert.ok(summary.repo);
  assert.equal(summary.worktree, true);
  assert.equal(summary.shallow, true);
  assert.equal(summary.stash, 2);
});

test('counts the submodules a repository declares, and none when it declares none', async () => {
  const declaring = await threadGit(
    repositoryAt({ status: clean, submodules: 3 }),
    '/workspace/alpha',
  );
  assert.ok(declaring.repo);
  assert.equal(declaring.submodules, 3);

  const plain = await threadGit(
    repositoryAt({ status: clean }),
    '/workspace/alpha',
  );
  assert.ok(plain.repo);
  assert.equal(plain.submodules, 0);
});

test('answers that a directory holding no repository is not one', async () => {
  const inside = fakeSandbox({
    entries: [{ path: 'plain/file.txt', content: 'x' }],
  });
  assert.deepEqual(await threadGit(inside, '/workspace/plain'), {
    repo: false,
  });
  assert.deepEqual(await threadGit(inside, '/workspace/missing'), {
    repo: false,
  });
});

test('hints at a repository only when the directory holds its own .git marker', async () => {
  const github = repositoryAt({
    status: clean,
    origin: 'git@github.com:owner/repo.git',
  });
  assert.equal(await cwdRepoHint(github, '/workspace/alpha'), 'github');
  // A subdirectory lies in that repository without holding it.
  assert.equal(await cwdRepoHint(github, '/workspace/alpha/src'), undefined);
  assert.equal(await cwdRepoHint(github, '/workspace'), undefined);

  // A linked worktree's marker is a file, and it still counts as a repository.
  const worktree = fakeSandbox({
    entries: [
      { path: 'wt/.git', content: 'gitdir: /workspace/main/.git/worktrees/wt' },
    ],
  });
  assert.equal(await cwdRepoHint(worktree, '/workspace/wt'), 'git');
});

test('names a repository without a GitHub origin as a repository', async () => {
  assert.equal(
    await cwdRepoHint(repositoryAt({ status: clean }), '/workspace/alpha'),
    'git',
  );
  assert.equal(
    await cwdRepoHint(
      repositoryAt({
        status: clean,
        origin: 'https://notgithub.com/owner/repo.git',
      }),
      '/workspace/alpha',
    ),
    'git',
  );
  assert.equal(
    await cwdRepoHint(
      repositoryAt({ status: clean, origin: '/var/repos/repo' }),
      '/workspace/alpha',
    ),
    'git',
  );
});

test('reads every GitHub spelling of an origin URL', async () => {
  for (const origin of [
    'https://github.com/owner/repo.git',
    'ssh://git@github.com/owner/repo.git',
    'git@github.com:owner/repo.git',
    'https://github.com:8443/owner/repo.git',
  ]) {
    assert.equal(
      await cwdRepoHint(
        repositoryAt({ status: clean, origin }),
        '/workspace/alpha',
      ),
      'github',
      `expected github for ${origin}`,
    );
  }
});
