import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  defineMethod,
  defineService,
  ModelsV1,
  modelsMethods,
} from 'bundle/contracts';
import { createTestServices } from 'bundle/testing';
import {
  RuntimeUsageV1,
  runtimeUsageMethods,
  type ThreadUsage,
} from 'runtime/contracts';

import { UsageV1 } from '../src/contracts/index.js';
import { activate } from '../src/host/index.js';

const totals = {
  calls: 2,
  unpricedCalls: 0,
  cost: 0.5,
  inputTokens: 1200,
  outputTokens: 80,
  cachedInputTokens: 0,
  reasoningTokens: 0,
};

const stored: ThreadUsage = {
  context: {
    model: 'openai/gpt-5',
    providerId: 'openrouter',
    inputTokens: 1200,
  },
  total: totals,
  threads: [{ ...totals, threadId: 'thread-1', name: 'Thread' }],
};

type Request = { readonly providerId?: string; readonly model: string };

/**
 * The usage bundle activated over a stored projection (`runtime.usage/v1`)
 * and a `models/v1` whose `contextWindow` answers `capacity`.
 */
const usageOver = async (
  usage: Record<string, ThreadUsage>,
  capacity: (request: Request) => Promise<number | undefined>,
) => {
  const requests: Request[] = [];
  const unexpected = () => {
    throw new Error('Only contextWindow is read.');
  };
  const harness = createTestServices({
    bundle: { id: 'usage' },
    provide: [
      defineService(RuntimeUsageV1, {
        read: defineMethod({
          ...runtimeUsageMethods.read,
          execute: async (threadId: string) => usage[threadId],
        }),
      }),
      // By id: kind takes a tuple, which the typed form cannot express.
      defineService(ModelsV1.id, {
        resolve: defineMethod({
          ...modelsMethods.resolve,
          execute: unexpected,
        }),
        kinds: defineMethod({ ...modelsMethods.kinds, execute: unexpected }),
        kind: defineMethod({ ...modelsMethods.kind, execute: unexpected }),
        catalog: defineMethod({
          ...modelsMethods.catalog,
          execute: unexpected,
        }),
        prepare: defineMethod({
          ...modelsMethods.prepare,
          execute: unexpected,
        }),
        contextWindow: defineMethod({
          ...modelsMethods.contextWindow,
          execute: async (request: Request) => {
            requests.push(request);
            return capacity(request);
          },
        }),
      }),
    ],
  });
  await activate({ services: harness.services });
  return { usage: harness.services.use(UsageV1), requests };
};

describe('usage/v1.thread', () => {
  test('fills a missing capacity from the catalog and marks its source', async () => {
    const { usage, requests } = await usageOver(
      { 'thread-1': stored },
      async () => 400_000,
    );

    assert.deepEqual(await usage.thread('thread-1'), {
      ...stored,
      context: {
        model: 'openai/gpt-5',
        providerId: 'openrouter',
        inputTokens: 1200,
        contextWindow: 400_000,
        contextWindowSource: 'catalog',
      },
    });
    assert.deepEqual(requests, [
      { providerId: 'openrouter', model: 'openai/gpt-5' },
    ]);
  });

  test('asks by model alone when the measurement names no provider', async () => {
    const { usage, requests } = await usageOver(
      { 'thread-1': { ...stored, context: { model: 'openai/gpt-5' } } },
      async () => 128_000,
    );

    assert.deepEqual((await usage.thread('thread-1'))?.context, {
      model: 'openai/gpt-5',
      contextWindow: 128_000,
      contextWindowSource: 'catalog',
    });
    assert.deepEqual(requests, [{ model: 'openai/gpt-5' }]);
  });

  test('never replaces a recorded capacity', async () => {
    const recorded: ThreadUsage = {
      ...stored,
      context: {
        model: 'openai/gpt-5',
        inputTokens: 10,
        contextWindow: 64_000,
      },
    };
    const { usage, requests } = await usageOver(
      { 'thread-1': recorded },
      async () => 400_000,
    );

    assert.deepEqual(await usage.thread('thread-1'), recorded);
    assert.deepEqual(requests, []);
  });

  test('leaves a Thread without a measurement as stored', async () => {
    const unmeasured: ThreadUsage = { total: totals, threads: [] };
    const { usage, requests } = await usageOver(
      { 'thread-1': unmeasured },
      async () => 400_000,
    );

    assert.deepEqual(await usage.thread('thread-1'), unmeasured);
    assert.deepEqual(requests, []);
  });

  for (const [label, answer] of [
    ['no single candidate (undefined)', async () => undefined],
    ['a zero capacity', async () => 0],
    ['a negative capacity', async () => -1],
    [
      'a failing catalog',
      async () => {
        throw new Error('catalog down');
      },
    ],
  ] as const) {
    test(`keeps the capacity unknown for ${label}`, async () => {
      const { usage } = await usageOver({ 'thread-1': stored }, answer);

      assert.deepEqual(await usage.thread('thread-1'), stored);
    });
  }

  test('answers undefined for an unknown Thread (thread_not_found)', async () => {
    const { usage, requests } = await usageOver({}, async () => 400_000);

    assert.equal(await usage.thread('missing'), undefined);
    assert.deepEqual(requests, []);
  });
});
