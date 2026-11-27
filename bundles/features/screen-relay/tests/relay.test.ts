// The relay's path mapping. The relay through real sockets — the HTTP proxy,
// the WebSocket passthrough, the 404s, forget and stop — is stated on the
// part's own listener in `router.test.ts` (A1–A8, A11); the shared-router
// `mount` left with the kernel host part (S69).

import assert from 'node:assert/strict';
import test from 'node:test';

import { relayTarget } from '../src/host/relay.js';

test('relayTarget maps token trees and refuses everything else', () => {
  const sessions = new Map([['t1', { host: '172.17.0.2', port: 14500 }]]);

  assert.deepEqual(relayTarget('/screen/t1/js/x.js?q=1', sessions), {
    token: 't1',
    target: { host: '172.17.0.2', port: 14500 },
    path: '/js/x.js?q=1',
  });
  assert.equal(relayTarget('/screen/t1', sessions)?.path, '/');
  assert.equal(relayTarget('/screen/other/', sessions), undefined);
  assert.equal(relayTarget('/elsewhere', sessions), undefined);
  assert.equal(relayTarget(undefined, sessions), undefined);
});
