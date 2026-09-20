import assert from 'node:assert/strict';
import test from 'node:test';

import { z } from 'zod';

import { createMessageStorage } from 'messages';

import { type Agent, AgentErrorObject } from '../src/index.js';
import {
  call,
  collect,
  completeFinish,
  createProvider,
  createTestAgent as createAgent,
  createTools,
  streamEvents,
} from './fakes.js';

const createHarness = (turns: Parameters<typeof createProvider>[0]) => {
  const provider = createProvider(turns);
  const tools = createTools({ results: { lookup: { found: true } } });
  const messages = createMessageStorage();

  const agent = createAgent({
    provider: provider.provider,
    tools: tools.storage,
    messages,
    system: '',
    model: 'fake-model',
  });

  return { agent, messages, provider, tools };
};

const assertTurnLimit = (error: unknown): boolean => {
  assert.ok(error instanceof AgentErrorObject);

  assert.equal(error.data.code, 'turn_limit_exceeded');

  return true;
};

test('omitted maxTurns preserves an unbounded multi-turn completion', async () => {
  const harness = createHarness({
    complete: (_request, index) =>
      index === 0
        ? completeFinish('', [call('lookup')])
        : completeFinish('Done.'),
  });
  const response = await harness.agent.complete('Find it.');

  assert.equal(response.text, 'Done.');

  assert.equal(harness.provider.requests.length, 2);
});

test('invalid maxTurns values fail before message or provider activity', async () => {
  for (const maxTurns of [0, -1, 1.5, Number.NaN, Infinity, 2 ** 53]) {
    const completeHarness = createHarness({});

    await assert.rejects(
      completeHarness.agent.complete('Do not store.', { maxTurns }),
      TypeError,
    );

    assert.deepEqual(completeHarness.messages.list(), []);

    assert.equal(completeHarness.provider.requests.length, 0);

    const streamHarness = createHarness({});

    await assert.rejects(
      collect(streamHarness.agent.stream('Do not store.', { maxTurns })),
      TypeError,
    );

    assert.deepEqual(streamHarness.messages.list(), []);

    assert.equal(streamHarness.provider.requests.length, 0);
  }
});

test('a direct response succeeds with a one-turn limit', async () => {
  const harness = createHarness({ complete: () => completeFinish('Done.') });
  const response = await harness.agent.complete('Answer.', { maxTurns: 1 });

  assert.equal(response.text, 'Done.');

  assert.equal(harness.provider.requests.length, 1);
});

for (const mode of ['complete', 'stream'] as const) {
  test(`${mode} stores tools from the final turn and fails before another provider call`, async () => {
    const lookup = call('lookup', { query: 'evidence' });

    const harness = createHarness({
      complete: () => completeFinish('', [lookup]),
      stream: () => streamEvents(completeFinish('', [lookup])),
    });

    const run =
      mode === 'complete'
        ? harness.agent.complete('Find it.', { maxTurns: 1 })
        : collect(harness.agent.stream('Find it.', { maxTurns: 1 }));

    await assert.rejects(run, assertTurnLimit);

    assert.equal(harness.provider.requests.length, 1);

    assert.equal(harness.tools.calls.length, 1);

    const message = harness.messages.list().at(-1);

    assert.equal(message?.role, 'tool');

    assert.equal(message?.toolCallId, lookup.id);

    assert.match(String(message?.content), /\{"found":true\}/u);
  });
}

test('stream exhaustion preserves earlier events without emitting agent.finished', async () => {
  const harness = createHarness({
    stream: () =>
      streamEvents(completeFinish('', [call('lookup', {}, 'call-stream')])),
  });
  const events: string[] = [];

  await assert.rejects(async () => {
    for await (const event of harness.agent.stream('Find it.', {
      maxTurns: 1,
    })) {
      events.push(event.type);
    }
  }, assertTurnLimit);

  assert.ok(events.includes('response.finished'));

  assert.ok(events.includes('tool.finished'));

  assert.ok(!events.includes('agent.finished'));
});

test('structured-output repair attempts consume the same turn limit', async () => {
  const schema = z.object({ answer: z.string() });

  const lookup = {
    name: 'lookup',
    inputSchema: { type: 'object' as const },
    outputSchema: {},
  };

  const provider = createProvider({
    complete: () => completeFinish('Not structured.'),
  });

  const agent: Agent = createAgent({
    provider: provider.provider,
    tools: createTools({ definitions: [lookup] }).storage,
    messages: createMessageStorage(),
    system: '',
    model: 'fake-model',
  });

  await assert.rejects(
    agent.complete('Return evidence.', { schema, maxTurns: 1 }),
    assertTurnLimit,
  );

  assert.equal(provider.requests.length, 1);
});
