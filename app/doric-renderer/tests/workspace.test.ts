import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { connectionLabel } from '../src/domain/connection';
import {
  limitName,
  nameError,
  projectColors,
  projectColorSwatch,
  type Thread,
  threadsForProject,
  threadSubtreeIds,
  upsert,
  withoutThreadSubtree,
} from '../src/domain/workspace';

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

describe('project colors', () => {
  test('paints every palette color and nothing else', () => {
    assert.deepEqual(
      Object.keys(projectColorSwatch).sort(),
      [...projectColors].sort(),
    );
    for (const color of projectColors) {
      assert.ok(projectColorSwatch[color].length > 0);
    }
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
