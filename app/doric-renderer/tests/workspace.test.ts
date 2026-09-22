import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { connectionLabel } from '../src/app/connection';
import {
  dropTargetFor,
  limitName,
  moveThreadTab,
  nameError,
  openThreadTab,
  type Thread,
  threadsForProject,
  threadSubtreeIds,
  upsert,
  withoutThreadSubtree,
} from '../src/app/workspace';

const thread = (id: string, projectId: string): Thread => ({
  id,
  projectId,
  name: id,
  state: 'ready',
  createdAt: '',
  updatedAt: '',
});

describe('connection status', () => {
  test('presents each preload status as its user-visible label', () => {
    assert.equal(connectionLabel('connected'), 'Connected');
    assert.equal(connectionLabel('disconnected'), 'Disconnected');
  });
});

describe('workspace state helpers', () => {
  test('filters cached threads by project', () => {
    assert.deepEqual(
      threadsForProject(
        [thread('one', 'project-a'), thread('two', 'project-b')],
        'project-a',
      ).map(({ id }) => id),
      ['one'],
    );
  });

  test('replaces an older entity without duplicating it', () => {
    assert.deepEqual(
      upsert([thread('one', 'project-a')], {
        ...thread('one', 'project-a'),
        name: 'Updated',
      }).map(({ name }) => name),
      ['Updated'],
    );
  });

  test('prepends a new entity by default', () => {
    assert.deepEqual(
      upsert([thread('one', 'project-a')], thread('two', 'project-a')).map(
        ({ id }) => id,
      ),
      ['two', 'one'],
    );
  });

  test('appends a new entity after its siblings when asked to insert last', () => {
    assert.deepEqual(
      upsert(
        [thread('one', 'project-a'), thread('two', 'project-a')],
        thread('three', 'project-a'),
        'last',
      ).map(({ id }) => id),
      ['one', 'two', 'three'],
    );
  });

  test('opens each Thread tab once in click order and refreshes its name', () => {
    const first = thread('one', 'project-a');
    const second = thread('two', 'project-a');
    const opened = openThreadTab(openThreadTab([], first), second);

    assert.deepEqual(
      opened.map(({ id }) => id),
      ['one', 'two'],
    );
    assert.deepEqual(
      openThreadTab(opened, { ...first, name: 'Renamed' }).map(
        ({ id, name }) => ({ id, name }),
      ),
      [
        { id: 'one', name: 'Renamed' },
        { id: 'two', name: 'two' },
      ],
    );
  });

  test('moves an open Thread tab next to its drop target', () => {
    const opened = [
      thread('one', 'project-a'),
      thread('two', 'project-a'),
      thread('three', 'project-a'),
    ];

    assert.deepEqual(
      moveThreadTab(opened, 'one', 'three', 'before').map(({ id }) => id),
      ['two', 'one', 'three'],
    );
    assert.deepEqual(
      moveThreadTab(opened, 'one', 'three', 'after').map(({ id }) => id),
      ['two', 'three', 'one'],
    );
    assert.deepEqual(
      moveThreadTab(opened, 'three', 'two', 'before').map(({ id }) => id),
      ['one', 'three', 'two'],
    );
  });

  test('resolves a drop target from the pointer and tab bounds', () => {
    const tabs = [
      { id: 'one', left: 100, width: 80 },
      { id: 'two', left: 180, width: 80 },
      { id: 'three', left: 260, width: 80 },
    ];

    assert.deepEqual(dropTargetFor(tabs, 100), {
      id: 'one',
      position: 'before',
    });
    assert.deepEqual(dropTargetFor(tabs, 150), {
      id: 'two',
      position: 'before',
    });
    assert.deepEqual(dropTargetFor(tabs, 230), {
      id: 'three',
      position: 'before',
    });
  });

  test('drops past the last tab into the empty tab bar space', () => {
    const tabs = [
      { id: 'one', left: 100, width: 80 },
      { id: 'two', left: 180, width: 80 },
    ];

    assert.deepEqual(dropTargetFor(tabs, 300), {
      id: 'two',
      position: 'after',
    });
    assert.deepEqual(dropTargetFor(tabs, 219), {
      id: 'two',
      position: 'before',
    });
    assert.equal(dropTargetFor([], 300), undefined);
  });

  test('removes a deleted thread subtree without removing its siblings', () => {
    const root = thread('root', 'project-a');
    const child = {
      ...thread('child', 'project-a'),
      parentThreadId: root.id,
    };
    const grandchild = {
      ...thread('grandchild', 'project-a'),
      parentThreadId: child.id,
    };
    const sibling = thread('sibling', 'project-a');
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

describe('inline name rules', () => {
  test('limits input by Unicode code points rather than UTF-16 units', () => {
    assert.equal(limitName('😀'.repeat(81)), '😀'.repeat(80));
    assert.equal(nameError('😀'.repeat(80)), undefined);
  });

  test('rejects empty and null-containing names', () => {
    assert.equal(nameError('  '), 'Enter a name between 1 and 80 characters.');
    assert.equal(
      nameError('unsafe\0name'),
      'Names cannot contain a null character.',
    );
  });
});
