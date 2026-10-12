import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import {
  defineMethod,
  defineService,
  LogV1,
  logMethods,
} from 'bundle/contracts';
import { createMinimalHooks, createTestServices } from 'bundle/testing';
import { SandboxV1 } from 'runtime/contracts';

import { activateDockerSandbox } from '../src/host/sandbox.js';

const enabled = process.env.DORIC_TEST_SANDBOX === 'true';
const silent = defineMethod({ ...logMethods.info, execute: () => undefined });

void test('keeps a Project workspace across sandboxes on Docker until it is discarded', {
  skip: enabled ? false : 'Requires DORIC_TEST_SANDBOX=true',
}, async () => {
  const harness = createTestServices({
    bundle: { id: 'docker' },
    provide: [
      createMinimalHooks(),
      defineService(LogV1, {
        debug: silent,
        info: silent,
        warn: silent,
        error: silent,
      }),
    ],
  });
  const cleanup = activateDockerSandbox({
    environment: { DORIC_SANDBOX_IMAGE: 'node:22-slim' },
  })({ services: harness.services });
  const sandbox = harness.services.use(SandboxV1);
  const identity = randomUUID();

  try {
    const first = await sandbox.acquire({ identity });
    const [machine] = await sandbox.machines();

    assert.deepEqual(machine, { id: first.sandbox.id, provider: 'docker' });
    await first.sandbox.writeFile('kept.txt', 'kept');
    await first.release();
    assert.equal(await sandbox.machine(first.sandbox.id), undefined);

    const second = await sandbox.acquire({ identity });
    assert.equal(await second.sandbox.readFile('kept.txt'), 'kept');
    await second.release();

    await sandbox.discard(identity);

    const third = await sandbox.acquire({ identity });
    const listed = await third.sandbox.exec({ cmd: ['ls', '-A'] });
    assert.equal(listed.stdout.includes('kept.txt'), false);
    await third.release();
    await sandbox.discard(identity);
  } finally {
    await cleanup();
    await harness.dispose();
  }
});
