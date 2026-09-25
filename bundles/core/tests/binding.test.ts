import assert from 'node:assert/strict';
import test from 'node:test';

import pino from 'pino';

import type { SandboxSession } from 'sandbox';
import { createSandpool } from 'sandpool';

import factory from '../tools/write.js';
import { fakeHost } from './fake-sandbox.js';

test('binds a core tool to a lease and rejects operations after release', async () => {
  const files = new Map<string, string>();
  let disposed = false;

  const session: SandboxSession = {
    id: 'core-test',
    root: '/workspace',
    exec: async () => ({
      exitCode: 0,
      stdout: '',
      stderr: '',
      stdoutBytes: new Uint8Array(),
      stderrBytes: new Uint8Array(),
    }),
    cloneRepo: async () => ({ path: '/workspace/repo', commit: 'abc' }),
    readFile: async (path) => {
      const value = files.get(path);

      if (value === undefined) {
        throw new Error('missing');
      }

      return value;
    },
    writeFile: async (path, content) => {
      files.set(path, content);
    },
    putFile: async () => undefined,
    getFile: async () => new Uint8Array(),
    diff: async () => '',
    ssh: async () => undefined,
    dispose: async () => {
      disposed = true;
    },
  };

  const pool = createSandpool({
    minIdle: 0,
    maxSandboxes: 1,
    logger: pino({ enabled: false }),
    create: async () => session,
  });

  try {
    const lease = await pool.acquire();

    const result = await factory(lease.sandbox, fakeHost()).execute({
      path: 'result.md',
      content: '# Result',
    });

    assert.equal(result.success, true);

    assert.equal(files.get('/workspace/result.md'), '# Result');

    await lease.release();

    await assert.rejects(
      lease.sandbox.readFile('/workspace/result.md'),
      /lease is no longer active/u,
    );

    assert.equal(disposed, true);
  } finally {
    await pool.dispose();
  }
});
