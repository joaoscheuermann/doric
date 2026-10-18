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
  ConfigurationV1,
  type ConfigurationValue,
  type ContextCompactionConfig,
  configurationMethods,
} from 'host-config/contracts';
import {
  type CompactResult,
  RuntimeThreadsV1,
  RuntimeUsageV1,
  runtimeThreadsMethods,
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

/*
 * The compaction members: `compact` delegates to the runtime's Thread
 * service, while the target line reads and moves the policy on the
 * configuration in force (an absent section is the default one).
 */

describe('usage/v1 compaction members', () => {
  const baseConfiguration = (
    contextCompaction: ContextCompactionConfig | undefined,
  ): ConfigurationValue => ({
    providers: [
      {
        id: 'openrouter',
        kind: 'openrouter',
        configuration: {
          endpoint: 'https://openrouter.ai/api/v1',
          token: 'c1',
        },
        models: [],
      },
    ],
    models: {
      execution: { providerId: 'openrouter', model: 'openai/gpt-5' },
    },
    execution: {
      maxTurns: 8,
      ...(contextCompaction === undefined ? {} : { contextCompaction }),
    },
    tools: {},
  });

  const compactionOver = async (
    configuration: ConfigurationValue,
    compactAnswer: CompactResult,
  ) => {
    const compactedIds: string[] = [];
    const replaced: unknown[] = [];
    const unexpected = () => {
      throw new Error('Only compact and the configuration are read.');
    };
    const harness = createTestServices({
      bundle: { id: 'usage' },
      provide: [
        defineService(RuntimeUsageV1, {
          read: defineMethod({
            ...runtimeUsageMethods.read,
            execute: unexpected,
          }),
        }),
        // By id: the runtime threads contract names every Thread method.
        defineService(RuntimeThreadsV1.id, {
          compact: defineMethod({
            ...runtimeThreadsMethods.compact,
            execute: async ({ id }: { readonly id: string }) => {
              compactedIds.push(id);
              return compactAnswer;
            },
          }),
        }),
        defineService(ConfigurationV1.id, {
          current: defineMethod({
            ...configurationMethods.current,
            execute: () => ({
              configuration,
              revision: 1,
              updatedAt: new Date(0).toISOString(),
            }),
          }),
          replace: defineMethod({
            ...configurationMethods.replace,
            execute: async (input: unknown) => {
              replaced.push(input);
              return {
                status: 'replaced' as const,
                config: {
                  configuration: input as ConfigurationValue,
                  revision: 2,
                  updatedAt: new Date(0).toISOString(),
                },
              };
            },
          }),
        }),
      ],
    });
    await activate({ services: harness.services });
    return {
      usage: harness.services.use(UsageV1),
      compactedIds,
      replaced,
    };
  };

  test('compact delegates to the runtime threads service with the id', async () => {
    const answer: CompactResult = {
      status: 'compacted',
      condensedMessages: 4,
      retainedMessages: 3,
      tokensFreed: 900,
    };
    const { usage, compactedIds } = await compactionOver(
      baseConfiguration(undefined),
      answer,
    );

    assert.deepEqual(await usage.compact('thread-1'), answer);
    assert.deepEqual(compactedIds, ['thread-1']);
  });

  test('compactionTarget reads the section and falls back to the default', async () => {
    const withSection = await compactionOver(
      baseConfiguration({
        enabled: true,
        pressurePercent: 65,
        tailMinMessages: 6,
        summaryMaxChars: 6000,
        charBudget: 200000,
      }),
      { status: 'refused', reason: 'nothing_to_compact' } as CompactResult,
    );
    assert.deepEqual(await withSection.usage.compactionTarget(), {
      pressurePercent: 65,
    });

    const absent = await compactionOver(baseConfiguration(undefined), {
      status: 'refused',
      reason: 'nothing_to_compact',
    } as CompactResult);
    assert.deepEqual(await absent.usage.compactionTarget(), {
      pressurePercent: 80,
    });
  });

  test('setCompactionTarget moves the section and keeps the rest of the configuration', async () => {
    const section: ContextCompactionConfig = {
      enabled: true,
      pressurePercent: 80,
      tailMinMessages: 6,
      summaryMaxChars: 6000,
      charBudget: 200000,
    };
    const { usage, replaced } = await compactionOver(
      baseConfiguration(section),
      { status: 'refused', reason: 'nothing_to_compact' } as CompactResult,
    );

    assert.deepEqual(await usage.setCompactionTarget({ pressurePercent: 90 }), {
      pressurePercent: 90,
    });
    assert.equal(replaced.length, 1);
    const next = replaced[0] as {
      execution: { contextCompaction: object; maxTurns: number };
    };
    assert.equal(next.execution.maxTurns, 8);
    assert.deepEqual(next.execution.contextCompaction, {
      ...section,
      pressurePercent: 90,
    });
  });

  test('a refused replace keeps the line the configuration still names', async () => {
    const section: ContextCompactionConfig = {
      enabled: true,
      pressurePercent: 80,
      tailMinMessages: 6,
      summaryMaxChars: 6000,
      charBudget: 200000,
    };
    const harness = createTestServices({
      bundle: { id: 'usage' },
      provide: [
        // By id: the runtime usage contract is otherwise fully typed.
        defineService(RuntimeUsageV1.id, {
          read: defineMethod({
            ...runtimeUsageMethods.read,
            execute: () => undefined,
          }),
        }),
        // By id: the runtime threads contract names every Thread method.
        defineService(RuntimeThreadsV1.id, {
          compact: defineMethod({
            ...runtimeThreadsMethods.compact,
            execute: () =>
              ({
                status: 'refused',
                reason: 'nothing_to_compact',
              }) as CompactResult,
          }),
        }),
        defineService(ConfigurationV1.id, {
          current: defineMethod({
            ...configurationMethods.current,
            execute: () => ({
              configuration: baseConfiguration(section),
              revision: 1,
              updatedAt: new Date(0).toISOString(),
            }),
          }),
          replace: defineMethod({
            ...configurationMethods.replace,
            execute: () => ({ status: 'rejected' }) as const,
          }),
        }),
      ],
    });
    await activate({ services: harness.services });
    const usage = harness.services.use(UsageV1);

    assert.deepEqual(await usage.setCompactionTarget({ pressurePercent: 90 }), {
      pressurePercent: 80,
    });
  });
});
