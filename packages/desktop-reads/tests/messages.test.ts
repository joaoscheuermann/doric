import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { messageFrom } from '../src/messages.js';

describe('the message of a failed operation', () => {
  test('is the error message when there is one', () => {
    assert.equal(messageFrom(new Error('No route.')), 'No route.');
  });

  test('falls back to the generic sentence otherwise', () => {
    assert.equal(messageFrom('boom'), 'The operation could not be completed.');
  });
});
