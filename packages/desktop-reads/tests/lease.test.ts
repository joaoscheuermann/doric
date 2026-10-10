import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { answerOf } from '../src/lease.js';
import { messageFrom } from '../src/messages.js';

describe('a host lease outcome as the read surfaces see it', () => {
  test('carries the ready value through', () => {
    assert.deepEqual(answerOf({ status: 'ready', value: { entries: [] } }), {
      status: 'ready',
      value: { entries: [] },
    });
  });

  test('gives a pending lease the one-second hint the route sent', () => {
    assert.deepEqual(answerOf({ status: 'pending' }), {
      status: 'pending',
      retryAfterSeconds: 1,
    });
  });

  test('keeps the other lease states as data', () => {
    for (const status of ['missing', 'expired', 'unavailable'] as const) {
      assert.deepEqual(answerOf({ status }), { status });
    }
  });
});

describe('the message of a failed operation', () => {
  test('is the error message when there is one', () => {
    assert.equal(messageFrom(new Error('No route.')), 'No route.');
  });

  test('falls back to the generic sentence otherwise', () => {
    assert.equal(messageFrom('boom'), 'The operation could not be completed.');
  });
});
