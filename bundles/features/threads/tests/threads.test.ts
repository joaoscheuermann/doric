import assert from 'node:assert/strict';
import test from 'node:test';

import { ContractError, isContractError } from 'bundle/contracts';
import type { AgentDefinition } from 'default/contracts';
import type {
  SpawnOptions,
  ThreadControl,
  ThreadView,
} from 'runtime/contracts';
import { createToolStorage, type ToolCall, ToolErrorObject } from 'tool';

import {
  activatedTools,
  defaultConfiguration,
  parentThreadId,
  type SpawnFakes,
} from './support/services.js';

const threadId = '018f47d2-e3b1-7b4f-8b2c-1f5a7fdf1601';
const promptId = '018f47d2-e3b1-7b4f-8b2c-1f5a7fdf1602';

/** A child record as the host stores it, with keys beyond ThreadView. */
const view: ThreadView & { readonly cwd: string } = {
  id: threadId,
  projectId: '018f47d2-e3b1-7b4f-8b2c-1f5a7fdf1600',
  parentThreadId: '018f47d2-e3b1-7b4f-8b2c-1f5a7fdf1603',
  name: 'Child',
  state: 'ready',
  lastSequence: 0,
  cwd: '/workspace',
  createdAt: '2026-10-09T00:00:00.000Z',
  updatedAt: '2026-10-09T00:00:00.000Z',
};

void test('registers thread tools in the established model-visible order', async () => {
  const tools = await activatedTools({} as never);
  const expected = [
    'thread-spawn',
    'thread-list',
    'thread-get',
    'thread-events',
    'thread-send',
    'thread-interrupt',
    'thread-terminate',
    'thread-restart',
    'ask',
  ];
  assert.deepEqual(
    tools.map((tool) => tool.name),
    expected,
  );
});

void test('preserves thread control arguments, defaults, and serialized results', async () => {
  const control: ThreadControl = {
    spawn: async (prompt, title) => {
      assert.equal(prompt, ' task ');
      assert.equal(title, ' Task ');
      return { threadId, promptId };
    },
    list: async (limit, cursor) => {
      assert.equal(limit, 50);
      assert.equal(cursor, undefined);
      return { items: [] };
    },
    get: async (id) => {
      assert.equal(id, threadId);
      return { thread: { ...view, id } };
    },
    events: async (id, afterSequence, limit) => {
      assert.equal(id, threadId);
      assert.equal(afterSequence, 0);
      assert.equal(limit, 20);
      return { events: [] };
    },
    send: async (id, prompt) => {
      assert.equal(id, threadId);
      assert.equal(prompt, ' follow-up ');
      return { status: 'accepted', promptId };
    },
    interrupt: async (id, activePromptId) => {
      assert.equal(id, threadId);
      assert.equal(activePromptId, promptId);
      return 'interrupted';
    },
    terminate: async (id) => {
      assert.equal(id, threadId);
      return { ...view, id, state: 'cancelled' };
    },
    restart: async (id, prompt) => {
      assert.equal(id, threadId);
      // The optional prompt reaches the host as written: the tool neither trims
      // it nor substitutes the child's own last prompt.
      assert.ok(prompt === undefined || prompt === ' again ');
      return { status: 'accepted', promptId };
    },
  };
  const storage = createToolStorage(await activatedTools(control));
  const execute = (name: string, payload: ToolCall['payload']) =>
    storage.execute({ id: 'call', name, payload });

  assert.equal(
    await execute('thread-spawn', { prompt: ' task ', title: ' Task ' }),
    JSON.stringify({ threadId, promptId }),
  );
  assert.equal(await execute('thread-list', {}), JSON.stringify({ items: [] }));
  assert.equal(
    await execute('thread-get', { threadId }),
    JSON.stringify({ thread: view }),
  );
  assert.equal(
    await execute('thread-events', { threadId }),
    JSON.stringify({ events: [] }),
  );
  assert.equal(
    await execute('thread-send', { threadId, prompt: ' follow-up ' }),
    JSON.stringify({ status: 'accepted', promptId }),
  );
  assert.equal(
    await execute('thread-interrupt', { threadId, promptId }),
    'interrupted',
  );
  assert.equal(
    await execute('thread-terminate', { threadId }),
    JSON.stringify({ ...view, state: 'cancelled' }),
  );
  assert.equal(
    await execute('thread-restart', { threadId }),
    JSON.stringify({ status: 'accepted', promptId }),
  );
  assert.equal(
    await execute('thread-restart', { threadId, prompt: ' again ' }),
    JSON.stringify({ status: 'accepted', promptId }),
  );
});

void test('rejects invalid thread control inputs at the tool boundary', async () => {
  const storage = createToolStorage(await activatedTools({} as never));
  for (const [name, payload] of [
    ['thread-spawn', { prompt: '   ' }],
    ['thread-spawn', { prompt: 'task', title: '  ' }],
    ['thread-spawn', { prompt: 'task', agent: 'Foo Bar' }],
    ['thread-spawn', { prompt: 'task', effort: 'turbo' }],
    ['thread-spawn', { prompt: 'task', model: '' }],
    ['thread-send', { threadId, prompt: '' }],
    ['thread-list', { limit: 0 }],
    ['thread-list', { limit: 101 }],
    ['thread-get', { threadId: 'invalid' }],
    ['thread-events', { threadId, afterSequence: -1 }],
    ['thread-events', { threadId, limit: 0 }],
    ['thread-events', { threadId, limit: 51 }],
    ['thread-interrupt', { threadId, promptId: 'invalid' }],
    ['thread-terminate', { threadId, extra: true }],
    ['thread-restart', { threadId: 'invalid' }],
    ['thread-restart', { threadId, prompt: '' }],
    ['thread-restart', { threadId, prompt: '   ' }],
    ['thread-restart', { threadId, extra: true }],
  ] as const) {
    const call: ToolCall = { id: 'call', name, payload };

    await assert.rejects(storage.execute(call), (error: unknown) => {
      assert.ok(error instanceof ToolErrorObject);
      assert.equal(error.data.code, 'invalid_payload');
      return true;
    });
  }
});

// thread-spawn with an agent, a model or an effort (DORIC-74). The tool is
// called as `parentThreadId`; `control.spawn` records what the runtime would
// receive, and the fakes record every other boundary read.

/** One harness: the spawns `control.spawn` received and the boundary calls. */
const spawnHarness = async (fakes: Omit<SpawnFakes, 'calls'> = {}) => {
  const spawns: [string, string | undefined, SpawnOptions | undefined][] = [];
  const calls: unknown[][] = [];
  const control = {
    spawn: async (
      prompt: string,
      title: string | undefined,
      options: SpawnOptions | undefined,
    ) => {
      spawns.push([prompt, title, options]);
      return { threadId, promptId };
    },
  } as unknown as ThreadControl;
  const storage = createToolStorage(
    await activatedTools(control, { ...fakes, calls }),
  );
  const spawn = (payload: ToolCall['payload']) =>
    storage.execute({ id: 'call', name: 'thread-spawn', payload });

  return { spawn, spawns, calls };
};

/** The spawn options of the only spawn. */
const onlyOptions = (spawns: readonly unknown[][]): unknown => {
  assert.equal(spawns.length, 1);
  return spawns[0]?.[2];
};

/** The requests `models/v1.resolve` received. */
const resolved = (calls: readonly unknown[][]) =>
  calls
    .filter(([name]) => name === 'models.resolve')
    .map(([, request]) => request);

/** The tool call failed in its handler; `check` inspects the original error. */
const failsWith = (run: Promise<unknown>, check: (cause: unknown) => void) =>
  assert.rejects(run, (error: unknown) => {
    assert.ok(error instanceof ToolErrorObject);
    assert.equal(error.data.code, 'handler_failed');
    check(error.cause);
    return true;
  });

const failsWithMessage = (run: Promise<unknown>, message: string) =>
  failsWith(run, (cause) => {
    assert.ok(cause instanceof Error);
    assert.equal(cause.message, message);
  });

const review: AgentDefinition = {
  name: 'review',
  source: 'built-in',
  description: 'Reviews.',
  instructions: 'Review it.',
};

void test('spawns without an agent, a model or an effort exactly as before', async () => {
  const { spawn, spawns, calls } = await spawnHarness();

  assert.equal(
    await spawn({ prompt: 'task', title: 'Task' }),
    JSON.stringify({ threadId, promptId }),
  );
  assert.deepEqual(spawns, [['task', 'Task', undefined]]);
  assert.deepEqual(calls, []);
});

void test('spawns as an agent with its name, source and instructions only', async () => {
  const { spawn, spawns, calls } = await spawnHarness({
    agents: (name) => (name === 'review' ? review : assert.fail(name)),
  });

  assert.equal(
    await spawn({ prompt: 'task', agent: 'review' }),
    JSON.stringify({ threadId, promptId }),
  );
  assert.deepEqual(spawns, [
    [
      'task',
      undefined,
      {
        agent: {
          name: 'review',
          source: 'built-in',
          instructions: 'Review it.',
        },
      },
    ],
  ]);
  // No model or effort anywhere: neither the configuration nor models/v1.
  assert.deepEqual(calls, [['agents.resolve', 'review']]);
});

void test('an agent that is not defined fails the spawn with the agents error unchanged', async () => {
  const message =
    'Agent "nope" is not defined. Defined agents: review, explore.';
  const { spawn, spawns } = await spawnHarness({
    agents: () => {
      throw new ContractError('not_found', message, {
        name: 'nope',
        agents: ['review', 'explore'],
      });
    },
  });

  await failsWith(spawn({ prompt: 'task', agent: 'nope' }), (cause) => {
    assert.ok(isContractError(cause));
    assert.equal(cause.code, 'not_found');
    assert.equal(cause.message, message);
  });
  assert.deepEqual(spawns, []);
});

void test('an invalid workspace agent fails the spawn with the agents error unchanged', async () => {
  const message = 'Agent "broken" is invalid: the description is missing.';
  const { spawn, spawns } = await spawnHarness({
    agents: () => {
      throw new ContractError('invalid_definition', message, {
        name: 'broken',
        path: '/workspace/.agents/agents/broken.md',
        reason: 'the description is missing',
      });
    },
  });

  await failsWith(spawn({ prompt: 'task', agent: 'broken' }), (cause) => {
    assert.ok(isContractError(cause));
    assert.equal(cause.code, 'invalid_definition');
    assert.equal(cause.message, message);
  });
  assert.deepEqual(spawns, []);
});

void test('a model the execution provider does not list fails before resolving it', async () => {
  const { spawn, spawns, calls } = await spawnHarness();

  await failsWithMessage(
    spawn({ prompt: 'task', model: 'gpt-9' }),
    'Model "gpt-9" is not available on provider "openai". Available models: gpt-5, gpt-5-mini.',
  );
  assert.deepEqual(resolved(calls), []);
  assert.deepEqual(spawns, []);
});

void test('an effort the listed model does not support fails the spawn', async () => {
  const { spawn, spawns } = await spawnHarness();

  await failsWithMessage(
    spawn({ prompt: 'task', model: 'gpt-5', effort: 'max' }),
    'Effort "max" is not supported by model "gpt-5". Supported efforts: low, medium, high.',
  );
  assert.deepEqual(spawns, []);
});

void test('a model the configured provider cannot resolve fails with the models error', async () => {
  const { spawn, spawns, calls } = await spawnHarness({
    configuration: {
      providers: defaultConfiguration.providers,
      models: { execution: { providerId: 'missing', model: 'gpt-5-mini' } },
    },
  });

  await failsWithMessage(
    spawn({ prompt: 'task', model: 'x' }),
    'Configured provider is unavailable.',
  );
  assert.deepEqual(resolved(calls), [{ providerId: 'missing', model: 'x' }]);
  assert.deepEqual(spawns, []);
});

void test('a provider without a model list accepts any model and effort', async () => {
  const { spawn, spawns, calls } = await spawnHarness({
    configuration: {
      providers: [
        { id: 'local', kind: 'openai-compatible', configuration: {} },
      ],
      models: { execution: { providerId: 'local', model: 'base' } },
    },
  });

  await spawn({ prompt: 'task', model: 'anything', effort: 'xhigh' });

  assert.deepEqual(resolved(calls), [
    { providerId: 'local', model: 'anything', effort: 'xhigh' },
  ]);
  // The model is given: the parent's record is never read.
  assert.equal(
    calls.some(([name]) => name === 'thread'),
    false,
  );
  assert.deepEqual(onlyOptions(spawns), { model: 'anything', effort: 'xhigh' });
});

void test('an effort alone is checked against the model the parent runs on', async () => {
  const { spawn, spawns, calls } = await spawnHarness({
    parent: { model: 'gpt-5' },
  });

  await spawn({ prompt: 'task', effort: 'high' });

  assert.ok(
    calls.some((entry) => entry[0] === 'thread' && entry[1] === parentThreadId),
  );
  assert.deepEqual(resolved(calls), [
    { providerId: 'openai', model: 'gpt-5', effort: 'high' },
  ]);
  // The child inherits the parent's model on its own: only the effort is passed.
  assert.deepEqual(onlyOptions(spawns), { effort: 'high' });
});

void test("an effort the parent's model does not support fails the spawn", async () => {
  const { spawn, spawns } = await spawnHarness({ parent: { model: 'gpt-5' } });

  await failsWithMessage(
    spawn({ prompt: 'task', effort: 'max' }),
    'Effort "max" is not supported by model "gpt-5". Supported efforts: low, medium, high.',
  );
  assert.deepEqual(spawns, []);
});

void test('an effort alone under a parent without a model uses the execution model', async () => {
  const { spawn, spawns, calls } = await spawnHarness({ parent: {} });

  await spawn({ prompt: 'task', effort: 'low' });

  assert.deepEqual(resolved(calls), [
    { providerId: 'openai', model: 'gpt-5-mini', effort: 'low' },
  ]);
  assert.deepEqual(onlyOptions(spawns), { effort: 'low' });
});

void test("an agent's model and effort apply unless the spawn names its own", async () => {
  const agent = {
    name: 'review',
    source: 'workspace',
    instructions: 'Review it.',
  };
  const { spawn, spawns, calls } = await spawnHarness({
    agents: () => ({
      ...agent,
      source: 'workspace',
      description: 'Reviews.',
      model: 'gpt-5',
      effort: 'low',
    }),
  });

  await spawn({ prompt: 'task', agent: 'review' });
  await spawn({
    prompt: 'task',
    agent: 'review',
    model: 'gpt-5-mini',
    effort: 'high',
  });

  assert.deepEqual(
    spawns.map(([, , options]) => options),
    [
      { agent, model: 'gpt-5', effort: 'low' },
      { agent, model: 'gpt-5-mini', effort: 'high' },
    ],
  );
  assert.deepEqual(resolved(calls), [
    { providerId: 'openai', model: 'gpt-5', effort: 'low' },
    { providerId: 'openai', model: 'gpt-5-mini', effort: 'high' },
  ]);
});

void test('an agent fails the spawn when no runtime provides agent types', async () => {
  const { spawn, spawns } = await spawnHarness();

  await failsWithMessage(
    spawn({ prompt: 'task', agent: 'review' }),
    'Agent types are unavailable in this runtime.',
  );
  assert.deepEqual(spawns, []);

  assert.equal(
    await spawn({ prompt: 'task' }),
    JSON.stringify({ threadId, promptId }),
  );
  assert.deepEqual(spawns, [['task', undefined, undefined]]);
});
