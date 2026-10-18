import assert from 'node:assert/strict';
import test from 'node:test';

import { z } from 'zod';

import { defineMethod, defineService, ref } from '../src/contracts/index.js';
import { createTestServices } from '../src/testing/index.js';

const workspace = defineService('runtime.workspace/v1', {
  cwd: defineMethod({
    input: z.tuple([]),
    output: z.string(),
    execute: async (_input, call) => {
      await Promise.resolve();

      return `/workspace/${call.scope?.threadId ?? 'none'}:${call.caller.bundleId}`;
    },
  }),
});
const WorkspaceV1 = ref<typeof workspace>('runtime.workspace/v1');

void test('test services reach fake providers with the bundle under test as caller', async () => {
  const harness = createTestServices({
    bundle: { id: 'files' },
    provide: [workspace],
  });
  const call = harness.call({ projectId: 'p', threadId: 't' });

  assert.equal(call.caller.bundleId, 'test');
  assert.equal(
    await harness.services.use(WorkspaceV1, call.scope).cwd(call),
    '/workspace/t:files',
  );

  await harness.dispose();

  assert.equal(call.signal.aborted, true);
});
