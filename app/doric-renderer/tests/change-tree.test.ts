import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  changeDecorations,
  changeDirectoryKey,
  changedLineTotals,
  changesCount,
  changesTree,
  changesTreeView,
} from '../src/domain/change-tree';

const repository = {
  path: 'project',
  changes: [
    { path: 'read me.md', status: 'untracked' as const },
    {
      path: 'src/new.ts',
      originalPath: 'src/old.ts',
      status: 'renamed' as const,
      staged: true,
      unstaged: true,
    },
    { path: 'src/removed.ts', status: 'deleted' as const },
  ],
};

const repositories = [repository];

test('totals added and removed lines across repositories independently of file counts', () => {
  assert.deepEqual(
    changedLineTotals([
      { added: 20, removed: 3 },
      { added: 4, removed: 10 },
    ]),
    { added: 24, removed: 13 },
  );
  assert.deepEqual(changedLineTotals([]), { added: 0, removed: 0 });
});

test('groups changed paths in directories before files and retains deleted files', () => {
  const tree = changesTree(repository);
  assert.deepEqual(
    tree.map((entry) => entry.name),
    ['src', 'read me.md'],
  );
  assert.deepEqual(
    tree[0]?.children?.map((entry) => entry.path),
    ['project/src/new.ts', 'project/src/removed.ts'],
  );
  assert.equal(changesCount(repositories), 3);
});

test('decorates workspace paths and counts changes through repository ancestors', () => {
  const decorations = changeDecorations(repositories);
  assert.equal(decorations.get('project/read me.md')?.status, 'untracked');
  assert.equal(decorations.get('project/src')?.count, 2);
  assert.equal(decorations.get('project')?.count, 3);
  assert.equal(
    decorations.get('project/src/new.ts')?.description,
    'renamed · Staged and unstaged · From src/old.ts',
  );
  assert.equal(decorations.has('read me.md'), false);
});

test('searches rename origins without dropping the destination directory chain', () => {
  const tree = changesTree(repository, 'OLD.TS');
  assert.deepEqual(
    tree[0]?.children?.map((entry) => entry.name),
    ['new.ts'],
  );
  assert.deepEqual(changesTree(repository, 'absent'), []);
});

test('propagates a deeply nested modification through every ancestor', () => {
  const decorations = changeDecorations([
    {
      path: 'project',
      changes: [{ path: 'src/components/deep/file.ts', status: 'modified' }],
    },
  ]);
  for (const path of [
    'project',
    'project/src',
    'project/src/components',
    'project/src/components/deep',
  ]) {
    assert.equal(decorations.get(path)?.status, 'modified');
    assert.equal(decorations.get(path)?.count, 1);
  }
  assert.equal(decorations.has('project/unchanged'), false);
  assert.equal(changeDecorations([]).size, 0);
});

test('keeps additions green and summarizes mixed changes as modified regardless of order', () => {
  const additions = [
    { path: 'src/new.ts', status: 'added' as const },
    { path: 'src/untracked.ts', status: 'untracked' as const },
  ];
  assert.equal(
    changeDecorations([{ path: 'project', changes: additions }]).get(
      'project/src',
    )?.status,
    'added',
  );
  const changes = [
    ...additions,
    { path: 'src/old.ts', status: 'deleted' as const },
  ];
  for (const ordered of [changes, [...changes].reverse()]) {
    const decorations = changeDecorations([
      { path: 'project', changes: ordered },
    ]);
    assert.equal(decorations.get('project/src')?.status, 'modified');
    assert.equal(decorations.get('project/src')?.count, 3);
    assert.equal(
      decorations.get('project/src/untracked.ts')?.status,
      'untracked',
    );
  }
});

test('prioritizes conflicts in ancestor folders regardless of change order', () => {
  const changes = [
    { path: 'src/deep/conflict.ts', status: 'conflicted' as const },
    { path: 'src/new.ts', status: 'added' as const },
    { path: 'src/edit.ts', status: 'modified' as const },
  ];
  for (const ordered of [changes, [...changes].reverse()]) {
    const decorations = changeDecorations([
      { path: 'project', changes: ordered },
    ]);
    assert.equal(decorations.get('project/src/deep')?.status, 'conflicted');
    assert.equal(decorations.get('project/src')?.status, 'conflicted');
    assert.equal(decorations.get('project')?.status, 'conflicted');
  }
});

test('search reveals matches while preserving collapsed state when the search clears', () => {
  const collapsed = new Set([
    changeDirectoryKey('project', 'project'),
    changeDirectoryKey('project', 'project/src'),
  ]);
  const search = changesTreeView(repository, 'new', collapsed);
  assert.equal(search.open, true);
  assert.equal(search.expanded.has('project/src'), true);
  const cleared = changesTreeView(repository, '', collapsed);
  assert.equal(cleared.open, false);
  assert.equal(cleared.expanded.has('project/src'), false);
  assert.equal(cleared.changes.get('project/src/new.ts')?.status, 'renamed');
});
