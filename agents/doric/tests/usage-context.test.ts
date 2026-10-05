import assert from 'node:assert/strict';
import test from 'node:test';

import type { LlmProvider } from 'llms';

import type { Generation } from '../src/lib/config/generation.js';
import { defaultConfig } from '../src/lib/config/schema.js';
import { emptyTotals, type ThreadUsage } from '../src/lib/workspace/usage.js';
import { withContextCapacity } from '../src/lib/workspace/usage-context.js';

const usage: ThreadUsage = {
  context: { model: 'measured', inputTokens: 48000 },
  total: emptyTotals,
  threads: [],
};
const generation = (ids = ['router'], offline = false): Generation => ({
  snapshot: {
    revision: 1,
    updatedAt: new Date().toISOString(),
    configuration: {
      ...defaultConfig,
      providers: ids.map((id) => ({
        id,
        kind: 'unified',
        configuration: {},
        models: [{ name: 'measured' }],
      })),
      models: { execution: { providerId: 'router', model: 'new-selection' } },
    },
  },
  providers: new Map(
    ids.map((id) => [
      id,
      {
        models: async () => {
          if (offline) throw new Error('offline');
          return [
            { id: 'measured', contextWindow: 200000 },
            { id: 'new-selection', contextWindow: 999999 },
          ];
        },
      } as unknown as LlmProvider,
    ]),
  ),
  catalog: { skills: [], tools: [] },
  redactions: () => [],
});

void test('fills legacy context capacity using the measured model without rewriting charges or history', async () => {
  const result = await withContextCapacity(usage, generation());
  assert.deepEqual(result.context, {
    ...usage.context,
    contextWindow: 200000,
    contextWindowSource: 'catalog',
  });
  assert.equal(result.total, usage.total);
  assert.equal(usage.context?.contextWindow, undefined);
});

void test('keeps ambiguity and catalog failures unknown, and never replaces recorded capacity', async () => {
  assert.equal(
    await withContextCapacity(usage, generation(['one', 'two'])),
    usage,
  );
  assert.equal(
    await withContextCapacity(usage, generation(['router'], true)),
    usage,
  );
  const recorded = {
    ...usage,
    context: { model: 'measured', contextWindow: 100000 },
  };
  assert.equal(await withContextCapacity(recorded, generation()), recorded);
  const identified = {
    ...usage,
    context: { model: 'measured', providerId: 'two' },
  };
  assert.equal(
    (await withContextCapacity(identified, generation(['one', 'two']))).context
      ?.contextWindow,
    200000,
  );
  assert.equal(
    await withContextCapacity(identified, generation(['one'])),
    identified,
  );
});
