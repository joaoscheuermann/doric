import assert from 'node:assert/strict';
import { test } from 'node:test';

import { changedLineCounts } from '../src/domain/file-diff.js';

test('counts insertions and deletions without counting the absent side', () => {
  assert.deepEqual(
    changedLineCounts(
      [
        {
          originalStartLineNumber: 4,
          originalEndLineNumber: 0,
          modifiedStartLineNumber: 5,
          modifiedEndLineNumber: 7,
        },
        {
          originalStartLineNumber: 10,
          originalEndLineNumber: 11,
          modifiedStartLineNumber: 9,
          modifiedEndLineNumber: 0,
        },
      ],
      'one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\nnine\nten\neleven\n',
      'one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\nnine\n',
    ),
    { added: 3, removed: 2 },
  );
});

test('counts replaced lines independently and reports no changes for identical files', () => {
  assert.deepEqual(
    changedLineCounts(
      [
        {
          originalStartLineNumber: 2,
          originalEndLineNumber: 4,
          modifiedStartLineNumber: 2,
          modifiedEndLineNumber: 2,
        },
      ],
      'first\nold one\nold two\nold three\n',
      'first\nreplacement\n',
    ),
    { added: 1, removed: 3 },
  );
  assert.deepEqual(changedLineCounts([], 'same\n', 'same\n'), {
    added: 0,
    removed: 0,
  });
});

test('counts a newly created newline-terminated file without editor sentinel lines', () => {
  assert.deepEqual(
    changedLineCounts(
      [
        {
          originalStartLineNumber: 1,
          originalEndLineNumber: 1,
          modifiedStartLineNumber: 1,
          modifiedEndLineNumber: 2,
        },
      ],
      '',
      'export const created = true;\n',
    ),
    { added: 1, removed: 0 },
  );
});

test('counts a deleted file without adding the empty modified model line', () => {
  assert.deepEqual(
    changedLineCounts(
      [
        {
          originalStartLineNumber: 1,
          originalEndLineNumber: 3,
          modifiedStartLineNumber: 1,
          modifiedEndLineNumber: 1,
        },
      ],
      'first\nsecond\n',
      '',
    ),
    { added: 0, removed: 2 },
  );
});

test('counts real blank lines while excluding only the final newline sentinel', () => {
  assert.deepEqual(
    changedLineCounts(
      [
        {
          originalStartLineNumber: 1,
          originalEndLineNumber: 1,
          modifiedStartLineNumber: 1,
          modifiedEndLineNumber: 3,
        },
      ],
      '',
      '\n\n',
    ),
    { added: 2, removed: 0 },
  );
});
