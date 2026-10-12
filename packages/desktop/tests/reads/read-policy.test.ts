import assert from 'node:assert/strict';
import { test } from 'node:test';

import { pendingReadInterval, readRetry } from '../../src/reads/read-policy.js';

test('waits for the host lease retry hint before asking again', () => {
  assert.equal(
    pendingReadInterval({ status: 'pending', retryAfterSeconds: 12 }),
    12000,
  );
});

test('uses a safe delay when a pending lease has no usable hint', () => {
  for (const retryAfterSeconds of [undefined, 0, -1, Number.NaN]) {
    const delay = pendingReadInterval({ status: 'pending', retryAfterSeconds });
    assert.ok(typeof delay === 'number' && delay >= 1000);
  }
});

test('stops polling when a sandbox read is ready or cannot recover by waiting', () => {
  for (const status of [
    'ready',
    'expired',
    'unavailable',
    'missing',
    'invalid_path',
    'not_found',
  ]) {
    assert.equal(pendingReadInterval({ status }), false);
  }
  assert.equal(pendingReadInterval(undefined), false);
});

test('limits rejected reads to a finite retry budget with increasing delays', () => {
  assert.ok(readRetry.retry > 0 && readRetry.retry <= 3);
  assert.ok(readRetry.retryDelay(1) > readRetry.retryDelay(0));
  assert.ok(readRetry.retryDelay(2) > readRetry.retryDelay(1));
  assert.ok(readRetry.retryDelay(100) <= 30000);
});
