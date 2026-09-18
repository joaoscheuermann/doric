import assert from 'node:assert/strict';
import test from 'node:test';

import { z } from 'zod';

import { createMessageStorage } from 'messages';

import {
  AgentErrorObject,
  type AgentToolEvent,
  createAgent,
  createToolCallStorage,
} from '../src/index.js';
import {
  call,
  collect,
  completeFinish,
  createProvider,
  createTools,
  streamEvents,
} from './fakes.js';

test('appends immutable records with deterministic unique opaque IDs', () => {
  const ids = ['observation-1', 'observation-2'];
  const storage = createToolCallStorage({ createId: () => ids.shift() ?? '' });

  const first = storage.append(
    { id: 'call-1', name: 'lookup', payload: { query: 'doric' } },
    '{"found":true}',
  );

  assert.deepEqual(first, {
    id: 'observation-1',
    callId: 'call-1',
    toolName: 'lookup',
    input: '{"query":"doric"}',
    output: '{"found":true}',
  });

  assert.ok(Object.isFrozen(first));

  assert.notStrictEqual(storage.list(), storage.list());
});

test('creates distinct UUIDs by default', () => {
  const storage = createToolCallStorage();

  const first = storage.append(
    { id: 'call-1', name: 'lookup', payload: {} },
    'first',
  );

  const second = storage.append(
    { id: 'call-2', name: 'lookup', payload: {} },
    'second',
  );

  assert.match(first.id, /^[0-9a-f]{8}-[0-9a-f-]{27}$/u);

  assert.match(second.id, /^[0-9a-f]{8}-[0-9a-f-]{27}$/u);

  assert.notEqual(first.id, second.id);
});

for (const id of ['', '   ']) {
  test(`rejects the invalid observation ID ${JSON.stringify(id)}`, () => {
    const storage = createToolCallStorage({ createId: () => id });

    assert.throws(
      () => storage.append({ id: 'call-1', name: 'lookup', payload: {} }, 'ok'),
      (error: unknown) =>
        error instanceof AgentErrorObject &&
        error.data.code === 'tool_call_id_invalid',
    );
  });
}

test('rejects observation ID collisions without appending a second record', () => {
  const storage = createToolCallStorage({ createId: () => 'same-id' });

  storage.append({ id: 'call-1', name: 'lookup', payload: {} }, 'first');

  assert.throws(
    () =>
      storage.append({ id: 'call-2', name: 'lookup', payload: {} }, 'second'),
    (error: unknown) =>
      error instanceof AgentErrorObject &&
      error.data.code === 'tool_call_id_collision',
  );

  assert.equal(storage.list().length, 1);
});

test('rejects an unserializable tool input without appending a record', () => {
  const payload: Record<string, unknown> = {};

  payload.self = payload;

  const storage = createToolCallStorage({ createId: () => 'observation-1' });

  assert.throws(
    () =>
      storage.append(
        { id: 'call-1', name: 'lookup', payload: payload as never },
        'ok',
      ),
    (error: unknown) =>
      error instanceof AgentErrorObject &&
      error.data.code === 'tool_input_serialization_failed',
  );

  assert.deepEqual(storage.list(), []);
});

test('aborts an agent run when a generated observation ID collides', async () => {
  const storage = createToolCallStorage({ createId: () => 'same-id' });

  const agent = createAgent({
    provider: createProvider({
      complete: (_request, index) =>
        completeFinish('', [call('lookup', { index }, `call-${index}`)]),
    }).provider,
    tools: createTools({ results: { lookup: 'found' } }).storage,
    messages: createMessageStorage(),
    toolCalls: storage,
    system: '',
    model: 'fake-model',
  });

  await assert.rejects(
    agent.complete('Run.'),
    (error: unknown) =>
      error instanceof AgentErrorObject &&
      error.data.code === 'tool_call_id_collision',
  );

  assert.equal(storage.list().length, 1);
});

for (const mode of ['complete', 'stream'] as const) {
  test(`${mode} shares one observation ID across storage message and events`, async () => {
    const observationId = `observation-${mode}`;
    const storage = createToolCallStorage({ createId: () => observationId });
    const messages = createMessageStorage();
    const events: AgentToolEvent[] = [];
    const lookup = call('lookup', { query: mode });

    const provider = createProvider({
      complete: (_request, index) =>
        index === 0 ? completeFinish('', [lookup]) : completeFinish('Done.'),
      stream: (_request, index) =>
        streamEvents(
          index === 0 ? completeFinish('', [lookup]) : completeFinish('Done.'),
        ),
    });

    const agent = createAgent({
      provider: provider.provider,
      tools: createTools({ results: { lookup: { exit_code: 1 } } }).storage,
      messages,
      toolCalls: storage,
      system: '',
      model: 'fake-model',
    });

    const options = {
      onToolEvent: async (event: AgentToolEvent) => {
        await Promise.resolve();

        events.push(event);
      },
    };

    if (mode === 'complete') {
      await agent.complete('Run.', options);
    } else {
      await collect(agent.stream('Run.', options));
    }

    const record = storage.list()[0];

    assert.equal(record?.id, observationId);

    assert.equal(record?.output, '{"exit_code":1}');

    const message = messages.list().find(({ role }) => role === 'tool');

    assert.match(String(message?.content), new RegExp(observationId, 'u'));

    const finished = events.find(({ type }) => type === 'tool.finished');

    assert.equal(
      finished?.type === 'tool.finished' ? finished.record : undefined,
      record,
    );

    assert.deepEqual(
      events.map(({ type }) => type),
      ['tool.started', 'tool.finished'],
    );
  });
}

test('does not append terminal structured output or handler failures', async () => {
  const storage = createToolCallStorage({ createId: () => 'unused' });
  const schema = z.object({ answer: z.string() });

  const provider = createProvider({
    complete: (request) => {
      const terminal = request.tools?.at(-1);

      return completeFinish('', [
        call(terminal?.name ?? '', { answer: 'done' }, 'terminal-call'),
      ]);
    },
  });

  const agent = createAgent({
    provider: provider.provider,
    tools: createTools().storage,
    messages: createMessageStorage(),
    toolCalls: storage,
    system: '',
    model: 'fake-model',
  });

  await agent.complete('Finish.', { schema });

  assert.deepEqual(storage.list(), []);

  const failed = createAgent({
    provider: createProvider({
      complete: () => completeFinish('', [call('lookup')]),
    }).provider,
    tools: createTools({ failure: new Error('tool failed') }).storage,
    messages: createMessageStorage(),
    toolCalls: storage,
    system: '',
    model: 'fake-model',
  });

  await assert.rejects(failed.complete('Fail.'), /tool failed/u);

  assert.deepEqual(storage.list(), []);
});

test('does not append an unserializable result', async () => {
  const cyclic: Record<string, unknown> = {};

  cyclic.self = cyclic;

  const storage = createToolCallStorage({ createId: () => 'observation-1' });

  const agent = createAgent({
    provider: createProvider({
      complete: () => completeFinish('', [call('lookup')]),
    }).provider,
    tools: createTools({ results: { lookup: cyclic } }).storage,
    messages: createMessageStorage(),
    toolCalls: storage,
    system: '',
    model: 'fake-model',
  });

  await assert.rejects(
    agent.complete('Run.'),
    (error: unknown) =>
      error instanceof AgentErrorObject &&
      error.data.code === 'tool_result_serialization_failed',
  );

  assert.deepEqual(storage.list(), []);
});

test('keeps the final permitted turn in the ledger before turn exhaustion', async () => {
  const storage = createToolCallStorage({ createId: () => 'observation-1' });

  const agent = createAgent({
    provider: createProvider({
      complete: () => completeFinish('', [call('lookup')]),
    }).provider,
    tools: createTools({ results: { lookup: 'found' } }).storage,
    messages: createMessageStorage(),
    toolCalls: storage,
    system: '',
    model: 'fake-model',
  });

  await assert.rejects(
    agent.complete('Run.', { maxTurns: 1 }),
    (error: unknown) =>
      error instanceof AgentErrorObject &&
      error.data.code === 'turn_limit_exceeded',
  );

  assert.equal(storage.list()[0]?.id, 'observation-1');
});
