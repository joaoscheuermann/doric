// git.commands/v1 Project reads (stage 10, §3.8; ported from the runtime's
// provisional file-changes tests) and a Thread's Git summary, on real
// repositories, through a fake runtime whose lease is either held or in one
// of its other states. Lease states and refusals are data; no read acquires.

import assert from 'node:assert/strict';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, test } from 'node:test';

import { fakeRuntime, gitOver, repository } from './support/runtime.js';

const changedRepository = async (t: Parameters<typeof repository>[0]) => {
  const repo = await repository(t);
  await writeFile(join(repo.root, 'edited.ts'), 'one\ntwo\n');
  await writeFile(join(repo.root, 'old.ts'), 'moved\n');
  await repo.git('add', '.');
  await repo.git('commit', '-qm', 'initial');
  await writeFile(join(repo.root, 'edited.ts'), 'one\nthree\nfour\n');
  await rename(join(repo.root, 'old.ts'), join(repo.root, 'new.ts'));
  await repo.git('add', '-A', 'old.ts', 'new.ts');
  await mkdir(join(repo.root, 'docs'));
  await writeFile(join(repo.root, 'docs', 'notes.md'), 'a\nb\n');
  return repo;
};

describe('git.commands/v1 Project reads', () => {
  test('lists each change with its line totals, without patches', async (t) => {
    const repo = await changedRepository(t);
    const runtime = fakeRuntime();
    const { git, dispose } = gitOver(repo.sandbox, runtime);
    t.after(dispose);

    const outcome = await git({ projectId: 'project-1' }).changes({});
    assert.equal(outcome.status, 'ready');
    if (outcome.status !== 'ready' || outcome.value.status !== 'read')
      throw new Error('expected a read');
    assert.equal(outcome.value.path, undefined);
    const [workspace] = outcome.value.repositories;
    assert.equal(outcome.value.repositories.length, 1);
    assert.equal(workspace?.path, '');
    assert.deepEqual(
      workspace?.changes
        .map(({ path, status, originalPath }) => ({
          path,
          status,
          ...(originalPath === undefined ? {} : { originalPath }),
        }))
        .sort((left, right) => left.path.localeCompare(right.path)),
      [
        { path: 'docs/notes.md', status: 'untracked' },
        { path: 'edited.ts', status: 'modified' },
        { path: 'new.ts', status: 'renamed', originalPath: 'old.ts' },
      ],
    );
    // edited.ts: +2 -1; docs/notes.md: +2 untracked; the rename is unchanged.
    assert.deepEqual([workspace?.added, workspace?.removed], [4, 1]);
    assert.deepEqual(runtime.leases, ['project-1']);
  });

  test('scopes the changes to a path and refuses a missing or escaping one', async (t) => {
    const repo = await changedRepository(t);
    const { git, dispose } = gitOver(repo.sandbox, fakeRuntime());
    t.after(dispose);
    const project = git({ projectId: 'project-1' });

    const scoped = await project.changes({ path: 'docs' });
    assert.equal(
      scoped.status === 'ready' && scoped.value.status === 'read'
        ? JSON.stringify(
            scoped.value.repositories.map((repository) =>
              repository.changes.map((change) => change.path),
            ),
          )
        : scoped.status,
      JSON.stringify([['docs/notes.md']]),
    );
    assert.deepEqual(await project.changes({ path: 'nope' }), {
      status: 'ready',
      value: { status: 'not_found' },
    });
    assert.deepEqual(await project.changes({ path: '../outside' }), {
      status: 'ready',
      value: { status: 'invalid_path' },
    });
    assert.deepEqual(await project.diff({ path: 'nope' }), {
      status: 'ready',
      value: { status: 'not_found' },
    });
  });

  test('reads the tracked diff of the repositories a path reaches', async (t) => {
    const repo = await changedRepository(t);
    const { git, dispose } = gitOver(repo.sandbox, fakeRuntime());
    t.after(dispose);

    const outcome = await git({ projectId: 'project-1' }).diff({});
    if (outcome.status !== 'ready' || outcome.value.status !== 'read')
      throw new Error('expected a read');
    const [workspace] = outcome.value.repositories;
    assert.match(workspace?.diff ?? '', /\+three/u);
    assert.deepEqual(
      workspace?.changes.find((change) => change.path === 'docs/')?.status,
      'untracked',
    );
  });

  test('compares one changed file, HEAD against the working tree', async (t) => {
    const repo = await changedRepository(t);
    const { git, dispose } = gitOver(repo.sandbox, fakeRuntime());
    t.after(dispose);
    const project = git({ projectId: 'project-1' });

    const edited = await project.fileDiff({
      repository: '',
      path: 'edited.ts',
    });
    assert.equal(edited.status, 'ready');
    if (edited.status !== 'ready' || edited.value.status !== 'read')
      throw new Error('expected a comparison');
    assert.equal(edited.value.diff.original, 'one\ntwo\n');
    assert.equal(edited.value.diff.modified, 'one\nthree\nfour\n');
    assert.equal(edited.value.diff.status, 'modified');
    assert.equal(edited.value.diff.binary, false);

    const added = await project.fileDiff({
      repository: '',
      path: 'docs/notes.md',
    });
    assert.equal(
      added.status === 'ready' && added.value.status === 'read'
        ? `${added.value.diff.original}|${added.value.diff.modified}`
        : added.status,
      '|a\nb\n',
    );
    // An unchanged file has no comparison to show.
    await writeFile(join(repo.root, 'edited.ts'), 'one\ntwo\n');
    assert.deepEqual(
      await project.fileDiff({ repository: '', path: 'edited.ts' }),
      { status: 'ready', value: { status: 'not_found' } },
    );
  });

  test('refuses a comparison path outside the workspace before asking the lease', async (t) => {
    const repo = await changedRepository(t);
    const runtime = fakeRuntime({ lease: 'missing' });
    const { git, dispose } = gitOver(repo.sandbox, runtime);
    t.after(dispose);
    const project = git({ projectId: 'project-1' });

    for (const input of [
      { repository: '', path: '' },
      { repository: '', path: '../escape' },
      { repository: '/abs', path: 'a' },
      { repository: '', path: 'a\0b' },
    ]) {
      assert.deepEqual(await project.fileDiff(input), {
        status: 'ready',
        value: { status: 'invalid_path' },
      });
    }
    assert.deepEqual(runtime.leases, []);
  });

  test('answers a Project without a held lease with its lease state', async (t) => {
    const repo = await changedRepository(t);
    for (const state of [
      'pending',
      'unavailable',
      'expired',
      'missing',
    ] as const) {
      const { git, dispose } = gitOver(
        repo.sandbox,
        fakeRuntime({ lease: state }),
      );
      t.after(dispose);
      const project = git({ projectId: 'project-1' });
      assert.deepEqual(await project.changes({}), { status: state });
      assert.deepEqual(await project.diff({}), { status: state });
      assert.deepEqual(
        await project.fileDiff({ repository: '', path: 'edited.ts' }),
        { status: state },
      );
    }
    // Closing started, or the lease dropped, while the read ran.
    const dropped = gitOver(
      repo.sandbox,
      fakeRuntime({ dropDuringTask: true }),
    );
    t.after(dropped.dispose);
    assert.deepEqual(
      await dropped.git({ projectId: 'project-1' }).changes({}),
      {
        status: 'unavailable',
      },
    );
  });

  test("summarizes a Thread directory's repository", async (t) => {
    const repo = await changedRepository(t);
    const inside = gitOver(
      repo.sandbox,
      fakeRuntime({ cwd: join(repo.root, 'docs') }),
    );
    t.after(inside.dispose);
    const summary = await inside.git({}).status('thread-1');
    assert.equal(summary.status, 'ready');
    if (summary.status !== 'ready' || !summary.value.repo)
      throw new Error('expected a repository');
    assert.equal(summary.value.root, repo.root);
    assert.equal(summary.value.head, 'main');
    assert.deepEqual(summary.value.dirty, {
      staged: 1,
      modified: 1,
      untracked: 1,
    });

    const outside = gitOver(
      repo.sandbox,
      fakeRuntime({ cwd: join(repo.root, '..') }),
    );
    t.after(outside.dispose);
    assert.deepEqual(await outside.git({}).status('thread-1'), {
      status: 'ready',
      value: { repo: false },
    });
  });
});
