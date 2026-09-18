import assert from 'node:assert/strict';
import test from 'node:test';

import pino from 'pino';

import type { SandboxSession } from 'sandbox';
import { createSandpool } from 'sandpool';

test('warms, leases, replaces, releases, and shuts down sandboxes', async () => {
  let nextId = 0;
  const disposed: string[] = [];

  const pool = createSandpool({
    minIdle: 1,
    maxSandboxes: 1,
    logger: pino({ enabled: false }),
    create: async () => session(`sandbox-${++nextId}`, disposed),
  });

  await pool.waitUntilHeated();

  const first = await pool.acquire();

  await first.release();

  await pool.waitUntilHeated();

  const second = await pool.acquire();

  assert.notEqual(second.sandbox.id, first.sandbox.id);

  await second.release();

  await pool.dispose();

  assert.deepEqual(
    disposed,
    Array.from({ length: nextId }, (_, index) => `sandbox-${index + 1}`),
  );

  assert.equal(pool.status().lifecycle, 'disposed');

  assert.equal(pool.status().total, 0);
});

const session = (id: string, disposed: string[]): SandboxSession => ({
  id,
  root: '/workspace',
  exec: async () => ({
    exitCode: 0,
    stdout: '',
    stderr: '',
    stdoutBytes: new Uint8Array(),
    stderrBytes: new Uint8Array(),
  }),
  cloneRepo: async () => ({ path: '/workspace/repo', commit: 'abc123' }),
  readFile: async () => '',
  writeFile: async () => undefined,
  putFile: async () => undefined,
  getFile: async () => new Uint8Array(),
  diff: async () => '',
  ssh: async () => undefined,
  dispose: async () => {
    disposed.push(id);
  },
});
