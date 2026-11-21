import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  isDescribed,
  isProjectOpen,
  type ProjectTree,
  type Selection,
  threadsOf,
  withProjectOpen,
  withProjectToggled,
  withRecords,
  withSelection,
} from '../src/client/domain/project-tree.js';
import type { Project, Thread } from '../src/client/domain/workspace.js';

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

const tree = (
  projects: readonly Project[],
  threadsByProject: Readonly<Record<string, readonly Thread[]>>,
  selection: Selection = {},
): ProjectTree => ({ projects, threadsByProject, selection });

const ids = (threads: readonly Thread[]): readonly string[] =>
  threads.map(({ id }) => id);

describe('the Project tree', () => {
  test('opening a described Project selects its first Thread', () => {
    const opened = withSelection(
      tree([project('one')], { one: [thread('a', 'one'), thread('b', 'one')] }),
      { projectId: 'one' },
    );
    assert.deepEqual(opened.selection, { projectId: 'one', threadId: 'a' });
  });

  test('holds a Project\u2019s Threads only once the host has described them', () => {
    const described = tree([project('one')], { one: [thread('a', 'one')] });

    assert.equal(isDescribed(tree([project('one')], {}), 'one'), false);
    assert.deepEqual(threadsOf(tree([project('one')], {}), 'one'), []);
    assert.equal(isDescribed(described, 'one'), true);
    assert.equal(isDescribed(described, 'other'), false);
    assert.deepEqual(ids(threadsOf(described, 'one')), ['a']);
  });
});

// Bundle isolation phase 3: the layout's tree is a projection of
// runtime.records/v1. `withRecords` takes the mirror's Projects and described
// Threads, and repairs the selection as the record rules did before (R6).
describe('the tree takes the records of the mirror', () => {
  test('loading Threads selects the first only when the Project has no selected Thread', () => {
    const initial = tree([project('one')], {}, { projectId: 'one' });
    const records = {
      projects: [project('one')],
      threadsByProject: { one: [thread('a', 'one'), thread('b', 'one')] },
    };
    assert.equal(withRecords(initial, records).selection.threadId, 'a');
    const selected = withSelection(initial, {
      projectId: 'one',
      threadId: 'b',
    });
    assert.equal(withRecords(selected, records).selection.threadId, 'b');
  });

  test('a background Project load does not select its Threads', () => {
    const initial = tree(
      [project('one'), project('two')],
      {},
      { projectId: 'two' },
    );
    assert.deepEqual(
      withRecords(initial, {
        projects: [project('one'), project('two')],
        threadsByProject: { one: [thread('a', 'one')] },
      }).selection,
      { projectId: 'two' },
    );
  });

  test('takes the Projects and the described Threads it is given', () => {
    const after = withRecords(tree([project('one')], {}), {
      projects: [project('one'), project('two')],
      threadsByProject: { two: [thread('b', 'two')] },
    });

    assert.deepEqual(after.projects, [project('one'), project('two')]);
    assert.equal(isDescribed(after, 'one'), false);
    assert.deepEqual(ids(threadsOf(after, 'two')), ['b']);
  });

  test('empties the selection when the selected Project leaves', () => {
    const before = tree(
      [project('one'), project('two')],
      { one: [thread('a', 'one')], two: [thread('b', 'two')] },
      { projectId: 'one', threadId: 'a' },
    );
    const after = withRecords(before, {
      projects: [project('two')],
      threadsByProject: { two: [thread('b', 'two')] },
    });

    assert.deepEqual(after.selection, {});
    assert.deepEqual(after.projects, [project('two')]);
    assert.equal(isDescribed(after, 'one'), false);
  });

  test('empties the selection when the selected Project leaves before its Threads were described', () => {
    const before = tree(
      [project('one'), project('two')],
      {},
      { projectId: 'one', threadId: 'ghost' },
    );

    assert.deepEqual(
      withRecords(before, { projects: [project('two')], threadsByProject: {} })
        .selection,
      {},
    );
  });

  test('drops the selected Thread when it leaves, keeping its Project', () => {
    const before = tree(
      [project('one')],
      { one: [thread('parent', 'one'), thread('child', 'one', 'parent')] },
      { projectId: 'one', threadId: 'child' },
    );
    const after = withRecords(before, {
      projects: [project('one')],
      threadsByProject: { one: [] },
    });

    assert.deepEqual(after.selection, { projectId: 'one' });
    assert.deepEqual(threadsOf(after, 'one'), []);
  });

  test('keeps the selected Thread while it stays', () => {
    const before = tree(
      [project('one')],
      { one: [thread('a', 'one'), thread('b', 'one')] },
      { projectId: 'one', threadId: 'b' },
    );
    const after = withRecords(before, {
      projects: [project('one')],
      threadsByProject: { one: [thread('b', 'one')] },
    });

    assert.deepEqual(after.selection, { projectId: 'one', threadId: 'b' });
    assert.deepEqual(ids(threadsOf(after, 'one')), ['b']);
  });

  test('returns the same tree object when nothing changed', () => {
    const before = tree(
      [project('one')],
      { one: [thread('a', 'one')] },
      { projectId: 'one', threadId: 'a' },
    );

    assert.equal(
      withRecords(before, {
        projects: before.projects,
        threadsByProject: before.threadsByProject,
      }),
      before,
    );
  });

  test('leaves the tree it was given untouched', () => {
    const before = tree(
      [project('one')],
      { one: [thread('a', 'one')] },
      { projectId: 'one', threadId: 'a' },
    );

    withRecords(before, { projects: [], threadsByProject: {} });

    assert.deepEqual(before.projects, [project('one')]);
    assert.deepEqual(ids(threadsOf(before, 'one')), ['a']);
    assert.deepEqual(before.selection, { projectId: 'one', threadId: 'a' });
  });
});

describe('project rows open one at a time', () => {
  test('opening a Project leaves the open Projects as they were', () => {
    const open = withProjectOpen(new Set(['one']), 'two');

    assert.deepEqual([...open].sort(), ['one', 'two']);
  });

  test('toggling an open Project closes only that one', () => {
    const open = withProjectToggled(new Set(['one', 'two']), 'one');

    assert.deepEqual([...open].sort(), ['two']);
    assert.equal(isProjectOpen(open, 'one'), false);
    assert.equal(isProjectOpen(open, 'two'), true);
  });

  test('toggling a closed Project opens it beside the open ones', () => {
    const open = withProjectToggled(new Set(['one']), 'three');

    assert.deepEqual([...open].sort(), ['one', 'three']);
  });
});

describe('the first selection skips archived main threads (T-25, thread-archive §10.1)', () => {
  const archived = (value: Thread): Thread => ({
    ...value,
    archivedAt: '2026-11-10T12:00:00.000Z',
  });

  test('opening a Project selects its first main thread that is not archived', () => {
    const opened = withSelection(
      tree([project('one')], {
        one: [
          archived(thread('a', 'one')),
          thread('a1', 'one', 'a'),
          thread('b', 'one'),
        ],
      }),
      { projectId: 'one' },
    );

    assert.deepEqual(opened.selection, { projectId: 'one', threadId: 'b' });
  });

  test('a Project whose main threads are all archived selects no Thread', () => {
    const opened = withSelection(
      tree([project('one')], {
        one: [
          archived(thread('a', 'one')),
          thread('a1', 'one', 'a'),
          archived(thread('b', 'one')),
        ],
      }),
      { projectId: 'one' },
    );

    assert.deepEqual(opened.selection, { projectId: 'one' });
  });

  test('an archived Thread the selection names stays selected', () => {
    const opened = withSelection(
      tree([project('one')], {
        one: [archived(thread('a', 'one')), thread('b', 'one')],
      }),
      { projectId: 'one', threadId: 'a' },
    );

    assert.deepEqual(opened.selection, { projectId: 'one', threadId: 'a' });
  });
});
