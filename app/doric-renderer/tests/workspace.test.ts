import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  limitName,
  nameError,
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
