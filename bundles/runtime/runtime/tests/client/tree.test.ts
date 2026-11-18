// The record rules of the mirror's tree (`src/client/domain/tree.ts`), moved
// from the layout with their assertions: the record cases of
// `L/tests/project-tree.test.ts`, without the selection, which stays in the
// layout, and the `threadsForProject`, `upsert` and `withoutThreadSubtree`
// cases of `L/tests/workspace.test.ts`.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  applyUpdate,
  forgetProject,
  forgetThread,
  type RecordsTree,
  threadsForProject,
  upsert,
  withoutThreadSubtree,
  withProjects,
  withThreads,
} from '../../src/client/domain/tree.js';
import {
  type Project,
  type Thread,
  threadSubtreeIds,
} from '../../src/contracts/index.js';

const project = (id: string): Project => ({
  id,
  name: id,
  state: 'ready',
  configRevision: 0,
  createdAt: '',
  updatedAt: '',
});

const thread = (
  id: string,
  projectId: string,
  parentThreadId?: string,
): Thread =>
  parentThreadId === undefined
    ? {
        id,
        projectId,
        name: id,
        state: 'ready',
        lastSequence: 0,
        cwd: '/workspace/doric',
        createdAt: '',
        updatedAt: '',
      }
    : {
        id,
        projectId,
        parentThreadId,
        name: id,
        state: 'ready',
        lastSequence: 0,
        cwd: '/workspace/doric',
        createdAt: '',
        updatedAt: '',
      };

const emptyTree: RecordsTree = { projects: [], threadsByProject: {} };

const tree = (
  projects: readonly Project[],
  threadsByProject: Readonly<Record<string, readonly Thread[]>>,
): RecordsTree => ({ projects, threadsByProject });

/** Whether the host has described a Project's Threads: an absent key is "not yet". */
const isDescribed = (value: RecordsTree, projectId: string): boolean =>
  value.threadsByProject[projectId] !== undefined;

const threadsOf = (value: RecordsTree, projectId: string): readonly Thread[] =>
  value.threadsByProject[projectId] ?? [];

const ids = (threads: readonly Thread[]): readonly string[] =>
  threads.map(({ id }) => id);

describe('the record tree', () => {
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
    const snapshot = (threads: readonly Thread[]): RecordsTree =>
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

  test('applies a deletion update to the Thread and its subtree', () => {
    const after = applyUpdate(described, {
      kind: 'thread-deleted',
      projectId: 'one',
      threadId: 'child',
    });

    assert.deepEqual(ids(threadsOf(after, 'one')), ['parent', 'sibling']);
  });

  test('leaves a Project whose Threads were never described undescribed', () => {
    const undescribed = tree([project('one')], {});
    const after = forgetThread(undescribed, 'one', 'ghost');

    assert.equal(isDescribed(after, 'one'), false);
  });
});

describe('the removal of a Project', () => {
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

  test('leaves another Project\u2019s Threads alone', () => {
    const before = withThreads(
      tree([project('one'), project('two')], { one: [] }),
      'two',
      [thread('b', 'two')],
    );
    const after = applyUpdate(before, {
      kind: 'project-deleted',
      projectId: 'one',
    });

    assert.deepEqual(ids(threadsOf(after, 'two')), ['b']);
  });
});

const helperThread = (id: string, projectId: string): Thread => ({
  id,
  projectId,
  name: id,
  state: 'ready',
  lastSequence: 0,
  cwd: '/workspace/doric',
  createdAt: '',
  updatedAt: '',
});

describe('record helpers', () => {
  test('filters cached threads by project', () => {
    assert.deepEqual(
      threadsForProject(
        [helperThread('one', 'project-a'), helperThread('two', 'project-b')],
        'project-a',
      ).map(({ id }) => id),
      ['one'],
    );
  });

  test('replaces an older entity without duplicating it', () => {
    assert.deepEqual(
      upsert([helperThread('one', 'project-a')], {
        ...helperThread('one', 'project-a'),
        name: 'Updated',
      }).map(({ name }) => name),
      ['Updated'],
    );
  });

  test('prepends a new entity by default', () => {
    assert.deepEqual(
      upsert(
        [helperThread('one', 'project-a')],
        helperThread('two', 'project-a'),
      ).map(({ id }) => id),
      ['two', 'one'],
    );
  });

  test('appends a new entity after its siblings when asked to insert last', () => {
    assert.deepEqual(
      upsert(
        [helperThread('one', 'project-a'), helperThread('two', 'project-a')],
        helperThread('three', 'project-a'),
        'last',
      ).map(({ id }) => id),
      ['one', 'two', 'three'],
    );
  });

  test('removes a deleted thread subtree without removing its siblings', () => {
    const root = helperThread('root', 'project-a');
    const child = {
      ...helperThread('child', 'project-a'),
      parentThreadId: root.id,
    };
    const grandchild = {
      ...helperThread('grandchild', 'project-a'),
      parentThreadId: child.id,
    };
    const sibling = helperThread('sibling', 'project-a');
    const values = [root, child, grandchild, sibling];

    assert.deepEqual([...threadSubtreeIds(values, root.id)].sort(), [
      'child',
      'grandchild',
      'root',
    ]);
    assert.deepEqual(
      withoutThreadSubtree(values, root.id).map(({ id }) => id),
      ['sibling'],
    );
  });
});
