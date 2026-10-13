import assert from 'node:assert/strict';
import test from 'node:test';

import { z } from 'zod';

import { createHarness } from './support/harness.js';

test('manual compaction records its events with a PostgreSQL-compatible prompt UUID', async () => {
  const harness = createHarness({
    executor: {
      compact: async ({ session }) => {
        await session.record({
          event: { type: 'compaction.started', trigger: 'manual' },
        });
        await session.record({
          event: { type: 'compaction.failed', code: 'summarizer_failed' },
        });
        return { status: 'failed', code: 'summarizer_failed' };
      },
    },
  });
  try {
    const project = await harness.service.projects.create('Project');
    const thread = await harness.createThread(project.id);
    const append = harness.stores.threads.appendEvent;
    const ids: string[] = [];
    harness.stores.threads.appendEvent = async (id, promptId, event) => {
      z.uuid().parse(promptId);
      ids.push(promptId);
      return append(id, promptId, event);
    };
    assert.deepEqual(await harness.service.threads.compact(thread.id), {
      status: 'failed',
      code: 'summarizer_failed',
    });
    assert.equal(ids.length, 2);
    assert.equal(ids[0], ids[1]);
  } finally {
    await harness.dispose();
  }
});
