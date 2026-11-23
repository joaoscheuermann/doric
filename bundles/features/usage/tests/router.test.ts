import assert from 'node:assert/strict';
import { describe, type TestContext, test } from 'node:test';

import { create, type JsonObject, toJson } from '@bufbuild/protobuf';
import { ContractError, isContractError } from 'bundle/contracts';
import { contractErrorOf } from 'bundle/host';
import {
  type ContextCompactionConfig,
  configurationValueSchema,
  defaultContextCompaction,
} from 'host-config/contracts';
import { ConfigurationValueSchema } from 'host-config/contracts/gen/doric/host_config/configuration/v1/configuration_pb.js';
import type { ThreadUsage } from 'runtime/contracts';
import { CompactResponseSchema as RuntimeCompactResponseSchema } from 'runtime/contracts/gen/doric/runtime/threads/v1/threads_pb.js';
import { ThreadUsageSchema } from 'runtime/contracts/gen/doric/runtime/v2/runtime_pb.js';

import {
  CompactResponseSchema,
  ThreadResponseSchema,
} from '../src/contracts/gen/doric/usage/v1/usage_pb.js';
import { withContextCapacity } from '../src/host/usage.js';
import {
  type CompactInit,
  type ConfigurationInit,
  type Harness,
  type HarnessOptions,
  harness,
  scope,
  type ThreadUsageInit,
} from './support/router.js';

// `usage`'s host part through the router (phase 3, S50c, U1–U16): `usage/v1`
// over `runtime.usage/v1`, `runtime.threads/v1`, `host-config/v1` and
// `models/v1`, as `src/host/main.ts` serves it.

const totals = {
  calls: 2,
  unpricedCalls: 0,
  cost: 0.5,
  inputTokens: 1200,
  outputTokens: 80,
  cachedInputTokens: 0,
  reasoningTokens: 0,
};

/** A stored usage whose context is `context` (none when `undefined`). */
const storedWith = (
  context: ThreadUsageInit['context'] | undefined,
): ThreadUsageInit => ({
  ...(context === undefined ? {} : { context }),
  total: totals,
  threads: [{ ...totals, threadId: 'thread-1', name: 'Thread' }],
});

/** The JSON of a usage, as the response's `threadUsage` is compared. */
const usageJson = (usage: ThreadUsageInit) =>
  toJson(ThreadUsageSchema, create(ThreadUsageSchema, usage));

/** A section that differs from the default in every member. */
const storedSection: ContextCompactionConfig = {
  enabled: false,
  pressurePercent: 70,
  tailMinMessages: 8,
  summaryMaxChars: 4000,
  charBudget: 150000,
};

/** A full configuration: providers, models, tools, profile, threads. */
const fullConfiguration = (
  contextCompaction: ContextCompactionConfig | undefined,
): ConfigurationInit => ({
  providers: [
    {
      id: 'openrouter',
      kind: 'openrouter',
      configuration: { apiKey: '5f0f7a52-8a3e-4c9b-9b36-2f6f2b5e0d11' },
      models: [
        {
          name: 'openai/gpt-5',
          reasonings: ['low', 'medium', 'high'],
          defaultEffort: 'medium',
          mandatory: true,
        },
      ],
    },
    { id: 'local', kind: 'ollama', configuration: {} },
  ],
  models: {
    execution: {
      providerId: 'openrouter',
      model: 'openai/gpt-5',
      effort: 'high',
    },
  },
  execution: {
    maxTurns: 40,
    maxToolResultChars: 30000,
    ...(contextCompaction === undefined ? {} : { contextCompaction }),
  },
  tools: { web: { region: 'br' }, terminal: { shell: 'bash' } },
  gitCredentialId: '0d3c1a52-1f0e-4f0a-9d5e-4b2c3a1d0e9f',
  profile: { name: 'Jao', timezone: 'America/Sao_Paulo' },
  threads: { autoArchive: { agentThreads: false, mainThreadsAfter: '30d' } },
});

/** The configuration's JSON, the form `Replace.input` carries. */
const configurationJson = (configuration: ConfigurationInit): JsonObject =>
  toJson(
    ConfigurationValueSchema,
    create(ConfigurationValueSchema, configuration),
    { alwaysEmitImplicit: true },
  ) as JsonObject;

/** `json` with `execution.contextCompaction` replaced by `section`. */
const withSection = (json: JsonObject, section: JsonObject): JsonObject => ({
  ...json,
  execution: {
    ...(json.execution as JsonObject),
    contextCompaction: section,
  },
});

/** The harness, activated, stopped after the test. */
const activated = async (
  t: TestContext,
  options: HarnessOptions,
): Promise<Harness> => {
  const h = harness(options);

  t.after(() => h.router.control.stop());
  await h.activate();

  return h;
};

/** Asserts that `promise` rejects with the Doric code `code`. */
const rejectsWith = async (promise: Promise<unknown>, code: string) => {
  await assert.rejects(promise, (error: unknown) => {
    const doric = contractErrorOf(error);

    assert.ok(isContractError(doric), `expected a Doric error: ${doric}`);
    assert.equal(doric.code, code);

    return true;
  });
};

describe('usage/v1.Thread', () => {
  void test('U1: a context without capacity is filled from one ContextWindow{providerId, model}', async (t) => {
    const context = { model: 'm', providerId: 'p', inputTokens: 1200 };
    const h = await activated(t, {
      read: () => storedWith(context),
      contextWindow: () => 200000,
    });

    const response = await h.client.thread({ threadId: 'thread-1' });

    assert.deepEqual(
      h.contextWindows.map((r) => r.request),
      [{ providerId: 'p', model: 'm' }],
    );
    assert.ok(response.threadUsage !== undefined);
    assert.deepEqual(
      toJson(ThreadUsageSchema, response.threadUsage),
      usageJson(
        storedWith({
          ...context,
          contextWindow: 200000,
          contextWindowSource: 'catalog',
        }),
      ),
    );
  });

  void test('U2: a context without providerId asks ContextWindow{model} alone', async (t) => {
    const h = await activated(t, {
      read: () => storedWith({ model: 'm' }),
      contextWindow: () => 200000,
    });

    await h.client.thread({ threadId: 'thread-1' });

    assert.deepEqual(
      h.contextWindows.map((r) => r.request),
      [{ model: 'm' }],
    );
  });

  void test('U3: a recorded capacity asks no model and is answered as read', async (t) => {
    const stored = storedWith({
      model: 'm',
      providerId: 'p',
      contextWindow: 128000,
      contextWindowSource: 'catalog',
    });
    const h = await activated(t, {
      read: () => stored,
      contextWindow: () => 200000,
    });

    const response = await h.client.thread({ threadId: 'thread-1' });

    assert.equal(h.contextWindows.length, 0);
    assert.ok(response.threadUsage !== undefined);
    assert.deepEqual(
      toJson(ThreadUsageSchema, response.threadUsage),
      usageJson(stored),
    );
  });

  describe('U4: an unusable capacity leaves the usage as read', () => {
    const cases: readonly (readonly [string, () => number | undefined])[] = [
      ['no answer', () => undefined],
      ['0', () => 0],
      ['a negative number', () => -1000],
      ['Infinity', () => Number.POSITIVE_INFINITY],
      [
        'a failure',
        () => {
          throw new ContractError('unavailable', 'The catalog is down.');
        },
      ],
      ['1.5, not a whole number (Q4)', () => 1.5],
    ];

    for (const [name, contextWindow] of cases) {
      void test(name, async (t) => {
        const stored = storedWith({ model: 'm', providerId: 'p' });
        const h = await activated(t, { read: () => stored, contextWindow });

        const response = await h.client.thread({ threadId: 'thread-1' });

        assert.equal(h.contextWindows.length, 1);
        assert.ok(response.threadUsage !== undefined);
        assert.deepEqual(
          toJson(ThreadUsageSchema, response.threadUsage),
          usageJson(stored),
        );
      });
    }
  });

  void test('U5: no stored usage answers {} and asks no model', async (t) => {
    const h = await activated(t, {
      read: () => undefined,
      contextWindow: () => 200000,
    });

    const response = await h.client.thread({ threadId: 'thread-1' });

    assert.deepEqual(toJson(ThreadResponseSchema, response), {});
    assert.deepEqual(
      h.reads.map((r) => r.request),
      ['thread-1'],
    );
    assert.equal(h.contextWindows.length, 0);
  });

  void test('U5: a usage without context is answered as read and asks no model', async (t) => {
    const stored = storedWith(undefined);
    const h = await activated(t, {
      read: () => stored,
      contextWindow: () => 200000,
    });

    const response = await h.client.thread({ threadId: 'thread-1' });

    assert.equal(h.contextWindows.length, 0);
    assert.ok(response.threadUsage !== undefined);
    assert.deepEqual(
      toJson(ThreadUsageSchema, response.threadUsage),
      usageJson(stored),
    );
  });

  void test('U6: a Read failure invalid_input fails Thread with invalid_input', async (t) => {
    const h = await activated(t, {
      read: () => {
        throw new ContractError('invalid_input', 'The thread id is invalid.');
      },
    });

    await rejectsWith(
      h.client.thread({ threadId: 'thread-1' }),
      'invalid_input',
    );
  });
});

describe('usage/v1.Compact', () => {
  const outcomes: readonly (readonly [string, CompactInit])[] = [
    [
      'compacted, with its three counts',
      {
        status: 'compacted',
        condensedMessages: 12,
        retainedMessages: 6,
        tokensFreed: 3400,
      },
    ],
    [
      'refused, nothing_to_compact',
      { status: 'refused', reason: 'nothing_to_compact' },
    ],
    [
      'failed, summarizer_failed',
      { status: 'failed', code: 'summarizer_failed' },
    ],
    ['busy', { status: 'busy' }],
  ];

  for (const [name, outcome] of outcomes) {
    void test(`U7: Compact{threadId} is runtime.threads/v1.Compact{id}; ${name} is copied`, async (t) => {
      const h = await activated(t, { compact: () => outcome });

      const response = await h.client.compact({ threadId: 't' });

      assert.deepEqual(
        h.compacts.map((r) => r.request),
        ['t'],
      );
      assert.deepEqual(
        toJson(CompactResponseSchema, response),
        toJson(
          RuntimeCompactResponseSchema,
          create(RuntimeCompactResponseSchema, outcome),
        ),
      );
    });
  }

  void test('U8: a Compact failure not_found fails with not_found', async (t) => {
    const h = await activated(t, {
      compact: () => {
        throw new ContractError('not_found', 'No such thread.');
      },
    });

    await rejectsWith(h.client.compact({ threadId: 't' }), 'not_found');
  });
});

describe('usage/v1.CompactionTarget', () => {
  void test('U9: the stored pressurePercent is answered', async (t) => {
    const h = await activated(t, {
      current: () => fullConfiguration(storedSection),
    });

    const response = await h.client.compactionTarget({});

    assert.equal(response.pressurePercent, 70);
  });

  void test('U9: no stored contextCompaction answers the default 80', async (t) => {
    const h = await activated(t, {
      current: () => fullConfiguration(undefined),
    });

    const response = await h.client.compactionTarget({});

    assert.equal(response.pressurePercent, 80);
  });
});

describe('usage/v1.SetCompactionTarget', () => {
  void test('U10: Replace gets the current configuration with only pressurePercent moved; replaced answers it', async (t) => {
    const configuration = fullConfiguration(storedSection);
    const h = await activated(t, {
      current: () => configuration,
      replace: () => 'replaced',
    });

    const response = await h.client.setCompactionTarget({
      pressurePercent: 60,
    });

    assert.equal(h.currents.length, 1);
    assert.deepEqual(
      h.replaces.map((r) => r.request),
      [
        withSection(configurationJson(configuration), {
          ...storedSection,
          pressurePercent: 60,
        }),
      ],
    );
    assert.equal(response.pressurePercent, 60);
  });

  const refusals = ['invalid', 'rejected'] as const;

  for (const status of refusals) {
    void test(`U11: Replace answering ${status} keeps the stored 70`, async (t) => {
      const h = await activated(t, {
        current: () => fullConfiguration(storedSection),
        replace: () => status,
      });

      const response = await h.client.setCompactionTarget({
        pressurePercent: 60,
      });

      assert.equal(h.replaces.length, 1);
      assert.equal(response.pressurePercent, 70);
    });

    void test(`U11: Replace answering ${status} with no stored section answers 80`, async (t) => {
      const h = await activated(t, {
        current: () => fullConfiguration(undefined),
        replace: () => status,
      });

      const response = await h.client.setCompactionTarget({
        pressurePercent: 60,
      });

      assert.equal(h.replaces.length, 1);
      assert.equal(response.pressurePercent, 80);
    });
  }

  void test('U12: no stored section writes the default section with the new pressurePercent', async (t) => {
    const configuration = fullConfiguration(undefined);
    const h = await activated(t, {
      current: () => configuration,
      replace: () => 'replaced',
    });

    const response = await h.client.setCompactionTarget({
      pressurePercent: 60,
    });

    const section = { ...defaultContextCompaction, pressurePercent: 60 };

    assert.deepEqual(
      h.replaces.map((r) => r.request),
      [withSection(configurationJson(configuration), section)],
    );
    assert.equal(response.pressurePercent, 60);
  });

  void test('U13: a Current failure unavailable fails with unavailable, without Replace', async (t) => {
    const h = await activated(t, {
      current: () => {
        throw new ContractError('unavailable', 'host-config is down.');
      },
    });

    await rejectsWith(
      h.client.setCompactionTarget({ pressurePercent: 60 }),
      'unavailable',
    );
    assert.equal(h.replaces.length, 0);
  });

  void test('U13: a Replace failure unavailable fails with unavailable', async (t) => {
    const h = await activated(t, {
      current: () => fullConfiguration(storedSection),
      replace: () => {
        throw new ContractError('unavailable', 'host-config is down.');
      },
    });

    await rejectsWith(
      h.client.setCompactionTarget({ pressurePercent: 60 }),
      'unavailable',
    );
  });

  void test('U14: Replace.input of a full configuration parses with the configuration schema, unchanged', async (t) => {
    const h = await activated(t, {
      current: () => fullConfiguration(storedSection),
      replace: () => 'replaced',
    });

    await h.client.setCompactionTarget({ pressurePercent: 60 });

    assert.equal(h.replaces.length, 1);
    const input = h.replaces[0]?.request;
    const parsed = configurationValueSchema.safeParse(input);

    assert.ok(parsed.success, parsed.error?.message);
    assert.deepEqual(parsed.data, input);
    assert.equal(parsed.data.providers.length, 2);
    assert.deepEqual(parsed.data.tools, {
      web: { region: 'br' },
      terminal: { shell: 'bash' },
    });
    assert.equal(parsed.data.execution.contextCompaction?.pressurePercent, 60);
  });
});

void test('U15: every routed call carries the calling scope', async (t) => {
  const h = await activated(t, {
    read: () => storedWith({ model: 'm', providerId: 'p' }),
    contextWindow: () => 200000,
    compact: () => ({ status: 'busy' }),
    current: () => fullConfiguration(storedSection),
    replace: () => 'replaced',
  });

  await h.client.thread({ threadId: 'thread-1' });
  await h.client.compact({ threadId: 'thread-1' });
  await h.client.compactionTarget({});
  await h.client.setCompactionTarget({ pressurePercent: 60 });

  const records = [
    ...h.reads,
    ...h.contextWindows,
    ...h.compacts,
    ...h.currents,
    ...h.replaces,
  ];

  assert.equal(h.reads.length, 1);
  assert.equal(h.contextWindows.length, 1);
  assert.equal(h.compacts.length, 1);
  assert.equal(h.currents.length, 2);
  assert.equal(h.replaces.length, 1);
  for (const record of records) {
    assert.deepEqual(record.scope, scope);
  }
});

void test('before activate, every usage/v1 method fails unavailable', async (t) => {
  const h = harness({
    read: () => storedWith(undefined),
    compact: () => ({ status: 'busy' }),
    current: () => fullConfiguration(storedSection),
  });

  t.after(() => h.router.control.stop());
  await h.serveWithoutActivate();

  await rejectsWith(h.client.thread({ threadId: 'thread-1' }), 'unavailable');
  await rejectsWith(h.client.compact({ threadId: 'thread-1' }), 'unavailable');
  await rejectsWith(h.client.compactionTarget({}), 'unavailable');
  await rejectsWith(
    h.client.setCompactionTarget({ pressurePercent: 60 }),
    'unavailable',
  );
  assert.equal(h.reads.length + h.compacts.length + h.currents.length, 0);
});

describe('U16: withContextCapacity on both usage forms', () => {
  const plain: ThreadUsage = {
    context: { model: 'm', providerId: 'p', inputTokens: 1200 },
    total: totals,
    threads: [{ ...totals, threadId: 'thread-1', name: 'Thread' }],
  };

  void test('a whole capacity fills today’s ThreadUsage', async () => {
    const filled = await withContextCapacity(plain, async () => 200000);

    assert.deepEqual(filled, {
      ...plain,
      context: {
        ...plain.context,
        contextWindow: 200000,
        contextWindowSource: 'catalog',
      },
    });
  });

  void test('a capacity that is not whole (1.5) leaves today’s ThreadUsage as given (Q4)', async () => {
    const filled = await withContextCapacity(plain, async () => 1.5);

    assert.deepEqual(filled, plain);
  });

  void test('a filled runtime.v2 ThreadUsage message keeps its $typeName and other fields', async () => {
    const message = create(ThreadUsageSchema, storedWith({ model: 'm' }));

    const filled = await withContextCapacity(message, async () => 200000);

    assert.equal(filled.$typeName, 'doric.runtime.v2.ThreadUsage');
    assert.deepEqual(
      toJson(ThreadUsageSchema, filled),
      usageJson(
        storedWith({
          model: 'm',
          contextWindow: 200000,
          contextWindowSource: 'catalog',
        }),
      ),
    );
  });
});
