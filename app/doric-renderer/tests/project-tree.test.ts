import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  applyUpdate,
  emptyTree,
  forgetProject,
  forgetThread,
  isDescribed,
  type ProjectTree,
  type Selection,
  threadsOf,
  withProjects,
  withSelection,
  withThreads,
} from '../src/domain/project-tree';
import type { Project, Thread } from '../src/domain/workspace';

const project = (id: string): Project => ({
  id,
  name: id,
  state: 'ready',
  createdAt: '',
  updatedAt: '',
});

const thread = (
  id: string,
  projectId: string,
  parentThreadId?: string,
): Thread =>
  parentThreadId === undefined
    ? { id, projectId, name: id, state: 'ready', createdAt: '', updatedAt: '' }
    : {
        id,
        projectId,
        parentThreadId,
        name: id,
        state: 'ready',
        createdAt: '',
        updatedAt: '',
      };

const tree = (
  projects: readonly Project[],
  threadsByProject: Readonly<Record<string, readonly Thread[]>>,
  selection: Selection = {},
): ProjectTree => ({ projects, threadsByProject, selection });

const ids = (threads: readonly Thread[]): readonly string[] =>
  threads.map(({ id }) => id);

describe('the Project tree', () => {
  test('holds a Project\u2019s Threads only once the host has described them', () => {
    const described = withThreads(tree([project('one')], {}), 'one', [
      thread('a', 'one'),
      thread('b', 'other'),
    ]);

    assert.equal(isDescribed(tree([project('one')], {}), 'one'), false);
    assert.deepEqual(threadsOf(tree([project('one')], {}), 'one'), []);
    assert.equal(isDescribed(described, 'one'), true);
    assert.equal(isDescribed(described, 'other'), false);
    assert.deepEqual(ids(threadsOf(described, 'one')), ['a']);
  });

  test('keeps the Projects it knows ahead of the ones the host lists again', () => {
    const listed = withProjects(emptyTree, [project('one'), project('two')]);
    const refreshed = withProjects(listed, [project('two'), project('three')]);

    assert.deepEqual(refreshed.projects, [
      project('one'),
      project('two'),
      project('three'),
    ]);
  });

  test('takes a snapshot as the truth about a Project\u2019s Threads', () => {
    const before = withThreads(
      withThreads(tree([project('one'), project('two')], {}), 'one', [
        thread('stale', 'one'),
      ]),
      'two',
      [thread('kept', 'two')],
    );
    const snapshot = (threads: readonly Thread[]): ProjectTree =>
      applyUpdate(before, {
        kind: 'snapshot',
        snapshot: { projectId: 'one', project: null, threads },
      });

    assert.deepEqual(
      ids(threadsOf(snapshot([thread('current', 'one')]), 'one')),
      ['current'],
    );
    assert.deepEqual(ids(threadsOf(snapshot([]), 'one')), []);
    assert.equal(isDescribed(snapshot([]), 'one'), true);
    assert.deepEqual(
      ids(threadsOf(snapshot([thread('current', 'one')]), 'two')),
      ['kept'],
    );
  });

  test('adds a Thread an update describes after its siblings', () => {
    const before = withThreads(tree([project('one')], {}), 'one', [
      thread('first', 'one'),
      thread('second', 'one'),
    ]);
    const after = applyUpdate(before, {
      kind: 'thread-updated',
      thread: thread('third', 'one'),
    });

    assert.deepEqual(ids(threadsOf(after, 'one')), [
      'first',
      'second',
      'third',
    ]);
  });

  test('keeps a Thread an update names in the place it already holds', () => {
    const before = withThreads(tree([project('one')], {}), 'one', [
      thread('first', 'one'),
      thread('second', 'one'),
      thread('third', 'one'),
    ]);
    const renamed = { ...thread('second', 'one'), name: 'second name' };
    const after = applyUpdate(before, {
      kind: 'thread-updated',
      thread: renamed,
    });

    assert.deepEqual(ids(threadsOf(after, 'one')), [
      'first',
      'second',
      'third',
    ]);
    assert.equal(threadsOf(after, 'one')[1], renamed);
  });

  test('renames a Project in the place it already holds', () => {
    const before = tree([project('one'), project('two')], {});
    const renamed = { ...project('one'), name: 'renamed' };
    const after = applyUpdate(before, {
      kind: 'project-updated',
      project: renamed,
    });

    assert.deepEqual(after.projects, [renamed, project('two')]);
  });

  test('leaves the tree it was given untouched', () => {
    const before = withThreads(tree([project('one')], {}), 'one', [
      thread('a', 'one'),
      thread('b', 'one'),
    ]);

    forgetProject(before, 'one');
    forgetThread(before, 'one', 'a');
    applyUpdate(before, { kind: 'thread-updated', thread: thread('c', 'one') });

    assert.deepEqual(before.projects, [project('one')]);
    assert.deepEqual(ids(threadsOf(before, 'one')), ['a', 'b']);
  });
});

describe('the removal of a Thread', () => {
  const described = withThreads(
    tree([project('one'), project('two')], {}),
    'one',
    [
      thread('parent', 'one'),
      thread('child', 'one', 'parent'),
      thread('grandchild', 'one', 'child'),
      thread('sibling', 'one'),
      thread('elsewhere', 'two'),
    ],
  );

  test('takes the Thread and its subtree out of the Threads the host described', () => {
    const after = forgetThread(described, 'one', 'parent');

    assert.deepEqual(ids(threadsOf(after, 'one')), ['sibling']);
  });

  test('leaves the selection on the Project that owned it', () => {
    const selected = withSelection(described, {
      projectId: 'one',
      threadId: 'child',
    });

    assert.deepEqual(forgetThread(selected, 'one', 'parent').selection, {
      projectId: 'one',
    });
    assert.deepEqual(forgetThread(selected, 'one', 'sibling').selection, {
      projectId: 'one',
      threadId: 'child',
    });
  });

  test('applies a deletion update to the Thread and its subtree', () => {
    const after = applyUpdate(described, {
      kind: 'thread-deleted',
      projectId: 'one',
      threadId: 'child',
    });

    assert.deepEqual(ids(threadsOf(after, 'one')), ['parent', 'sibling']);
  });

  test('leaves a Project whose Threads were never described undescribed', () => {
    const undescribed = tree(
      [project('one')],
      {},
      {
        projectId: 'one',
        threadId: 'ghost',
      },
    );
    const after = forgetThread(undescribed, 'one', 'ghost');

    assert.equal(isDescribed(after, 'one'), false);
    assert.deepEqual(after.selection, { projectId: 'one' });
  });
});

describe('the removal of a Project', () => {
  test('clears a selection pointing at it when no Thread was ever described', () => {
    const selected = tree(
      [project('one')],
      {},
      { projectId: 'one', threadId: 'thread' },
    );

    assert.deepEqual(forgetProject(selected, 'one').selection, {});
  });

  test('clears a selection pointing at it when the described Threads are stale', () => {
    const selected = tree(
      [project('one')],
      { one: [] },
      { projectId: 'one', threadId: 'thread' },
    );
    const withOtherThreads = tree(
      [project('one')],
      { one: [thread('other', 'one')] },
      { projectId: 'one', threadId: 'thread' },
    );

    assert.deepEqual(forgetProject(selected, 'one').selection, {});
    assert.deepEqual(forgetProject(withOtherThreads, 'one').selection, {});
  });

  test('forgets the Project and the Threads described for it', () => {
    const after = forgetProject(
      tree([project('one'), project('two')], {
        one: [thread('a', 'one')],
        two: [thread('b', 'two')],
      }),
      'one',
    );

    assert.deepEqual(after.projects, [project('two')]);
    assert.equal(isDescribed(after, 'one'), false);
    assert.deepEqual(ids(threadsOf(after, 'two')), ['b']);
  });

  test('leaves another Project\u2019s Threads and selection alone', () => {
    const before = withSelection(
      withThreads(tree([project('one'), project('two')], { one: [] }), 'two', [
        thread('b', 'two'),
      ]),
      { projectId: 'two', threadId: 'b' },
    );
    const after = applyUpdate(before, {
      kind: 'project-deleted',
      projectId: 'one',
    });

    assert.deepEqual(ids(threadsOf(after, 'two')), ['b']);
    assert.deepEqual(after.selection, { projectId: 'two', threadId: 'b' });
  });
});
