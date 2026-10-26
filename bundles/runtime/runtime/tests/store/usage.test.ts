import assert from 'node:assert/strict';
import test from 'node:test';

import {
  emptyUsage,
  projectUsage,
  usageTotals,
} from '../../src/host/store/usage.js';

const started = (model = 'model') => ({
  type: 'response.started',
  provider: 'openrouter',
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
    provider: 'openrouter',
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

void test('keeps charged usage after interruption', () => {
  const state = fold([started(), usage(0.5), { type: 'agent.cancelled' }]);
  assert.equal(usageTotals(state).cost, 0.5);
  assert.equal(usageTotals(state).calls, 1);
});

void test('counts a provider that reports no price as an unpriced call with its tokens and context', () => {
  const state = fold([
    started(),
    usage(0.5),
    {
      type: 'response.started',
      provider: 'claude',
      model: 'claude-opus-5-5',
      contextWindow: 1000000,
    },
    { type: 'usage', usage: { inputTokens: 1200, outputTokens: 300 } },
  ]);
  const totals = usageTotals(state);
  assert.equal(totals.calls, 2);
  assert.equal(totals.unpricedCalls, 1);
  assert.equal(totals.cost, 0.5);
  assert.equal(totals.inputTokens, 48000 + 1200);
  assert.equal(totals.outputTokens, 2000 + 300);
  assert.deepEqual(state.context, {
    model: 'claude-opus-5-5',
    contextWindow: 1000000,
    inputTokens: 1200,
  });
});

void test('keeps capacity unknown when absent and does not count cache twice', () => {
  const state = fold([
    { type: 'response.started', provider: 'openrouter', model: 'unknown' },
    usage(0.2),
  ]);
  assert.equal(state.context?.contextWindow, undefined);
  assert.equal(state.context?.inputTokens, 48000);
  assert.equal(usageTotals(state).inputTokens, 48000);
});

void test('combines historical Unified charges with new OpenRouter calls', () => {
  const state = fold([
    { ...started(), provider: 'unified' },
    usage(0.25),
    started(),
    usage(0.5),
  ]);
  assert.equal(usageTotals(state).cost, 0.75);
  assert.equal(usageTotals(state).calls, 2);
});
