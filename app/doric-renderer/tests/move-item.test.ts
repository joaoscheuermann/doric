import assert from 'node:assert/strict';
import { test } from 'node:test';

import { moveItem } from '../src/utility/move-item';

test('moves a navigation tab while retaining all remaining tabs in order', () => {
  assert.deepEqual(moveItem(['files', 'changes'], 0, 1), ['changes', 'files']);
  assert.deepEqual(moveItem(['a', 'b', 'c', 'd'], 3, 1), ['a', 'd', 'b', 'c']);
});

test('ignores a drop with no valid source or destination', () => {
  const drops: [number, number][] = [
    [-1, 0],
    [0, -1],
    [0, 2],
    [2, 0],
    [1, 1],
  ];
  for (const [from, to] of drops) {
    assert.deepEqual(moveItem(['files', 'changes'], from, to), [
      'files',
      'changes',
    ]);
  }
  assert.deepEqual(moveItem([], 0, 1), []);
});
