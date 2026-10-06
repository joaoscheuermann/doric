import assert from 'node:assert/strict';
import test from 'node:test';

import {
  contextLabel,
  costLabel,
  usageBreakdown,
  usageLabels,
  type UsageTotals,
} from '../src/domain/usage.js';

const total: UsageTotals = {
  calls: 1,
  unpricedCalls: 0,
  cost: 0.75,
  inputTokens: 0,
  outputTokens: 0,
  cachedInputTokens: 0,
  reasoningTokens: 0,
};

test('displays window usage without a Context prefix', () => {
  assert.equal(
    contextLabel({ model: 'm', inputTokens: 48000, contextWindow: 200000 }),
    '48K / 200K · 24%',
  );
  assert.equal(contextLabel({ model: 'm', inputTokens: 48000 }), '48K / ?');
  assert.equal(contextLabel({ model: 'm', contextWindow: 200000 }), '— / 200K');
});

test('distinguishes missing, free and sub-cent charges', () => {
  assert.equal(costLabel(total), '~$0.75');
  assert.equal(costLabel({ ...total, cost: 0 }), '~$0.00');
  assert.equal(costLabel({ ...total, cost: 0.001 }), '~<$0.01');
  assert.equal(costLabel({ ...total, unpricedCalls: 1 }), '—');
  assert.equal(costLabel({ ...total, calls: 0 }), '—');
});

test('separates current charges from all descendants without counting the parent twice', () => {
  const result = usageBreakdown(
    {
      total: { ...total, calls: 7, cost: 6 },
      threads: [
        {
          ...total,
          threadId: 'child',
          parentThreadId: 'root',
          name: 'Child',
          calls: 2,
          cost: 2,
          inputTokens: 10000,
          outputTokens: 2000,
        },
        { ...total, threadId: 'root', name: 'Current', calls: 4, cost: 3.5 },
        {
          ...total,
          threadId: 'grandchild',
          parentThreadId: 'child',
          name: 'Grandchild',
          cost: 0.5,
          unpricedCalls: 1,
          inputTokens: 5000,
          outputTokens: 1000,
        },
      ],
    },
    'root',
  );
  assert.equal(result.current.cost, 3.5);
  assert.equal(result.current.calls, 4);
  assert.deepEqual(
    result.subthreads.map((entry) => entry.threadId),
    ['child', 'grandchild'],
  );
  assert.equal(result.subtotal.cost, 2.5);
  assert.equal(result.subtotal.calls, 3);
  assert.equal(result.subtotal.unpricedCalls, 1);
  assert.deepEqual(usageLabels(result.subtotal), {
    calls: '3 calls',
    input: '15K',
    output: '3K',
  });
});

test('shows an empty subthread summary when a conversation has no descendants', () => {
  const result = usageBreakdown(
    { total, threads: [{ ...total, threadId: 'root', name: 'Current' }] },
    'root',
  );
  assert.equal(result.subthreads.length, 0);
  assert.equal(costLabel(result.subtotal), '—');
  assert.deepEqual(usageLabels(result.subtotal), {
    calls: '0 calls',
    input: '0',
    output: '0',
  });
});

test('formats compact token counts without adding cached or reasoning tokens again', () => {
  assert.deepEqual(
    usageLabels({
      ...total,
      inputTokens: 1250000,
      outputTokens: 12500,
      cachedInputTokens: 1000000,
      reasoningTokens: 8000,
    }),
    { calls: '1 call', input: '1.3M', output: '12.5K' },
  );
});
