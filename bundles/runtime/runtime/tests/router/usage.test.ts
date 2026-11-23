// `runtime.usage/v1` over the router (phase 3, slice S46a, contract §1.8):
// `Read{threadId}` answers the stored usage projection, unfilled. Test 26 of
// the slice.

import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import { toJson } from '@bufbuild/protobuf';

import { ThreadUsageSchema } from '../../src/contracts/gen/doric/runtime/v2/runtime_pb.js';
import { asJson, harness, seedThread, within } from './support.js';

const promptId = '00000000-0000-4000-8000-0000000000bb';
const unknownId = '00000000-0000-4000-8000-00000000ffff';

describe('runtime.usage/v1', () => {
  test('26: Read answers the stored usage of a Thread with usage, and {} for an unknown Thread', async (t) => {
    const h = harness();
    t.after(() => h.stop());
    const { thread } = await seedThread(h);
    for (const event of [
      { type: 'prompt.accepted', text: 'hi', source: { kind: 'user' } },
      {
        type: 'response.started',
        provider: 'openrouter',
        model: 'model',
        contextWindow: 200000,
      },
      {
        type: 'usage',
        usage: {
          inputTokens: 48000,
          outputTokens: 2000,
          cachedInputTokens: 10000,
          cost: { amount: 0.25, unit: 'credits' },
        },
      },
    ])
      await h.seed.threads.appendEvent(thread.id, promptId, event);
    const stored = await h.seed.threads.usage(thread.id);
    assert.ok(stored !== undefined, 'the seeded Thread has stored usage');
    await h.start();

    const { threadUsage } = await within(
      h.usage().read({ threadId: thread.id }),
      'Read',
    );

    assert.ok(threadUsage !== undefined);
    const answer = toJson(ThreadUsageSchema, threadUsage) as {
      context?: { model?: string };
      total?: { cost?: number; calls?: number };
      threads?: { threadId?: string }[];
    };
    const expected = asJson(stored) as typeof answer;
    assert.equal(answer.total?.cost, expected.total?.cost);
    assert.equal(answer.total?.cost, 0.25);
    assert.equal(answer.total?.calls, expected.total?.calls);
    assert.equal(answer.context?.model, expected.context?.model);
    assert.deepEqual(
      answer.threads?.map(({ threadId }) => threadId),
      expected.threads?.map(({ threadId }) => threadId),
    );

    const unknown = await within(
      h.usage().read({ threadId: unknownId }),
      'Read (unknown)',
    );
    assert.equal(unknown.threadUsage, undefined);
  });
});
