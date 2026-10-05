import assert from 'node:assert/strict';
import test from 'node:test';

import {
  emptyUsage,
  projectUsage,
  usageTotals,
} from '../src/lib/workspace/usage.js';

const started = (model = 'model') => ({
  type: 'response.started',
  provider: 'unified',
  model,
  contextWindow: 200000,
});
const usage = (cost: number) => ({
  type: 'usage',
  usage: {
    inputTokens: 48000,
    outputTokens: 2000,
    cachedInputTokens: 10000,
    cost: { amount: cost, unit: 'credits' },
  },
});
const fold = (events: readonly unknown[]) =>
  events.reduce(projectUsage, emptyUsage);

void test('retains the configured provider identity and resets context when the same model changes providers', () => {
  const state = fold([{ ...started(), providerId: 'first' }, usage(0.25)]);
  assert.equal(state.context?.providerId, 'first');
  const next = projectUsage(state, {
    type: 'response.started',
    provider: 'unified',
    model: 'model',
    providerId: 'second',
  });
  assert.deepEqual(next.context, { model: 'model', providerId: 'second' });
  assert.equal(usageTotals(next).cost, 0.25);
});

void test('counts each call once when usage is repeated in the finish and agent result', () => {
  const state = fold([
    started(),
    usage(0.25),
    usage(0.3),
    { type: 'response.finished', finish: { usage: usage(0.3).usage } },
    { type: 'agent.finished', response: { usage: usage(0.3).usage } },
    started(),
    usage(0.45),
  ]);
  assert.equal(usageTotals(state).cost, 0.75);
  assert.equal(usageTotals(state).calls, 2);
  assert.equal(usageTotals(state).inputTokens, 96000);
  assert.equal(state.context?.inputTokens, 48000);
});

void test('distinguishes missing prices from free calls and ignores upstream cost', () => {
  const state = fold([
    started(),
    { type: 'response.finished', finish: {} },
    started(),
    {
      type: 'usage',
      usage: { cost: { amount: 0, unit: 'credits', upstreamAmount: 3 } },
    },
  ]);
  assert.equal(usageTotals(state).cost, 0);
  assert.equal(usageTotals(state).unpricedCalls, 1);
  assert.equal(usageTotals(state).calls, 2);
});

void test('keeps charged usage after interruption and keeps providers outside unified out of the total', () => {
  const state = fold([
    started(),
    usage(0.5),
    { type: 'agent.cancelled' },
    { type: 'response.started', provider: 'openai', model: 'other' },
    usage(3),
  ]);
  assert.equal(usageTotals(state).cost, 0.5);
  assert.equal(usageTotals(state).calls, 1);
  assert.equal(state.context, undefined);
});

void test('keeps capacity unknown when absent and does not count cache twice', () => {
  const state = fold([
    { type: 'response.started', provider: 'unified', model: 'unknown' },
    usage(0.2),
  ]);
  assert.equal(state.context?.contextWindow, undefined);
  assert.equal(state.context?.inputTokens, 48000);
  assert.equal(usageTotals(state).inputTokens, 48000);
});
