// The routed-error helpers are one module (phase 3, slice S62b, A72, test
// 10): the browser-safe helpers live in `src/contracts/routed-errors.ts`, and
// the host's `src/host/rpc/errors.ts` re-exports the same bindings, so every
// host import keeps working unchanged. `detached` stays in the host module;
// its behaviour is covered by the router tests that use it.

import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import * as contracts from '../../src/contracts/routed-errors.js';
import * as host from '../../src/host/rpc/errors.js';

describe('S62b: src/host/rpc/errors.ts re-exports src/contracts/routed-errors.ts', () => {
  test('routed, routedError and parseInput are the same functions', () => {
    assert.equal(host.routed, contracts.routed);
    assert.equal(host.routedError, contracts.routedError);
    assert.equal(host.parseInput, contracts.parseInput);
  });

  test('the two error codes are the same values', () => {
    assert.equal(contracts.SHUTTING_DOWN, 'shutting_down');
    assert.equal(contracts.THREAD_CONTROL_INACTIVE, 'thread_control_inactive');
    assert.equal(host.SHUTTING_DOWN, contracts.SHUTTING_DOWN);
    assert.equal(
      host.THREAD_CONTROL_INACTIVE,
      contracts.THREAD_CONTROL_INACTIVE,
    );
  });

  test('detached stays in the host module only', () => {
    assert.equal(typeof host.detached, 'function');
    assert.equal('detached' in contracts, false);
  });
});
