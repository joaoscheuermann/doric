import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  changeClassName,
  changeDecorations,
  changeDirectoryKey,
  changedLineTotals,
  changeLetter,
  changeMarks,
  changesCount,
  changesTree,
  changesTreeView,
} from '../src/client/reads/change-tree.js';

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

test('gives every change the letter its badge carries', () => {
  assert.deepEqual(
    (['added', 'modified', 'deleted', 'renamed', 'untracked'] as const).map(
      changeLetter,
    ),
    ['A', 'M', 'D', 'R', 'U'],
  );
});

test('draws each status in the colour the palette gives it, added and untracked alike', () => {
  assert.equal(changeClassName('added'), 'text-[var(--git-added)]');
  assert.equal(changeClassName('untracked'), 'text-[var(--git-added)]');
  assert.equal(changeClassName('modified'), 'text-[var(--git-modified)]');
  assert.equal(changeClassName('deleted'), 'text-[var(--git-deleted)]');
  assert.equal(changeClassName('renamed'), 'text-[var(--git-renamed)]');
  assert.equal(changeClassName('conflicted'), 'text-[var(--git-conflicted)]');
});

test('marks a changed file with its colour, letter and count, and strikes only a deleted one', () => {
  const marks = changeMarks(repositories);
  assert.deepEqual(marks.get('project/read me.md'), {
    description: 'untracked · Unstaged',
    count: 1,
    tone: 'text-[var(--git-added)]',
    letter: 'U',
    struck: false,
  });
  assert.equal(marks.get('project/src/removed.ts')?.struck, true);
  assert.equal(marks.get('project/src/removed.ts')?.letter, 'D');
  assert.equal(marks.get('project/src')?.count, 2);
  assert.equal(marks.get('project/src')?.struck, false);
});

test('a directory mark carries the colour of the status it summarizes', () => {
  const marks = changeMarks([
    {
      path: 'project',
      changes: [
        { path: 'src/a.ts', status: 'deleted' },
        { path: 'src/b.ts', status: 'deleted' },
      ],
    },
  ]);
  assert.equal(marks.get('project/src')?.tone, 'text-[var(--git-deleted)]');
  assert.equal(marks.get('project/src')?.description, '2 changed files');
});

test('the changes view hands its tree the marks of the repository it draws', () => {
  const view = changesTreeView(repository, '', new Set());
  assert.equal(
    view.decorations.get('project/src/new.ts')?.tone,
    'text-[var(--git-renamed)]',
  );
  assert.equal(view.decorations.get('project/src/new.ts')?.struck, false);
});
