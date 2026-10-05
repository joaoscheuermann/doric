import assert from 'node:assert/strict';
import test from 'node:test';

import {
  contextLabel,
  costLabel,
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
