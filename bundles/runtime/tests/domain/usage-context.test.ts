import assert from 'node:assert/strict';
import test from 'node:test';

import type { ConfigurationValue } from '../../src/contracts/configuration.js';
import type { ThreadUsage } from '../../src/contracts/model.js';
import {
  type ModelCatalogSource,
  withContextCapacity,
} from '../../src/host/domain/usage-context.js';
import { emptyTotals } from '../../src/host/store/usage.js';
import { createHarness, defaultConfiguration } from './support/harness.js';

/*
 * Ported from agents/doric tests/usage-context.test.ts (design 57 §13.1,
 * stage 5 "Usage aggregate"): the provider is the one `models/v1.resolve`
 * answers for the configured provider id.
 */

const usage: ThreadUsage = {
  context: { model: 'measured', inputTokens: 48000 },
  total: emptyTotals,
  threads: [],
};

const catalog = (offline = false): ModelCatalogSource => ({
  models: async () => {
    if (offline) throw new Error('offline');
    return [
      { id: 'measured', contextWindow: 200000 },
      { id: 'new-selection', contextWindow: 999999 },
    ];
  },
});

const configuration = (ids = ['router']): ConfigurationValue => ({
  ...defaultConfiguration,
  providers: ids.map((id) => ({
    id,
    kind: 'openrouter',
    configuration: {},
    models: [{ name: 'measured' }],
  })),
  models: { execution: { providerId: 'router', model: 'new-selection' } },
});

/** models/v1.resolve over the given providers. */
const resolve =
  (ids = ['router'], offline = false) =>
  async (providerId: string) => {
    if (!ids.includes(providerId))
      throw new Error('Configured provider is unavailable.');
    return catalog(offline);
  };

void test('fills legacy context capacity using the measured model without rewriting charges or history', async () => {
  const result = await withContextCapacity(usage, configuration(), resolve());
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
    await withContextCapacity(
      usage,
      configuration(['one', 'two']),
      resolve(['one', 'two']),
    ),
    usage,
  );
  assert.equal(
    await withContextCapacity(
      usage,
      configuration(),
      resolve(['router'], true),
    ),
    usage,
  );
  const recorded = {
    ...usage,
    context: { model: 'measured', contextWindow: 100000 },
  };
  assert.equal(
    await withContextCapacity(recorded, configuration(), resolve()),
    recorded,
  );
  const identified = {
    ...usage,
    context: { model: 'measured', providerId: 'two' },
  };
  assert.equal(
    (
      await withContextCapacity(
        identified,
        configuration(['one', 'two']),
        resolve(['one', 'two']),
      )
    ).context?.contextWindow,
    200000,
  );
  assert.equal(
    await withContextCapacity(
      identified,
      configuration(['one']),
      resolve(['one']),
    ),
    identified,
  );
  // A provider models/v1 cannot resolve leaves the capacity unknown.
  assert.equal(
    await withContextCapacity(usage, configuration(), resolve([])),
    usage,
  );
});

void test('the Thread usage read fills the capacity from the resolved provider catalog', async () => {
  const harness = createHarness({
    configuration: () => ({
      configuration: configuration(),
      revision: 1,
      updatedAt: new Date(0).toISOString(),
    }),
    models: { router: catalog() },
    execute: async ({ session }) => {
      await session.record({
        event: {
          type: 'response.started',
          provider: 'openrouter',
          model: 'measured',
          providerId: 'router',
        },
      });
      return 'done';
    },
  });
  const project = await harness.readyProject();
  const thread = await harness.createThread(project.id);
  await harness.service.threads.prompt(thread.id, 'measure');
  await harness.waitFor(
    async () =>
      (await harness.service.threads.find(thread.id))?.result !== undefined,
  );
  assert.deepEqual((await harness.service.threads.usage(thread.id))?.context, {
    model: 'measured',
    providerId: 'router',
    contextWindow: 200000,
    contextWindowSource: 'catalog',
  });
  await harness.dispose();
});
