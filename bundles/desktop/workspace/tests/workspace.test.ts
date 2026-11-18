import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  limitName,
  nameError,
  projectColorSwatch,
  projectColors,
} from '../src/client/domain/workspace.js';

// The `threadSubtreeIds` case left with the function: it is the runtime's
// (`bundles/runtime/runtime/tests/runtime-contracts.test.ts`), step 4(c).

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
