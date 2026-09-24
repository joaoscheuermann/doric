import assert from 'node:assert/strict';
import test from 'node:test';

import { AgentErrorObject, type AgentEvent } from '../src/index.js';
import { z } from 'zod';
import {
  call,
  collect,
  completeFinish,
  createProvider,
  createTestAgent as createAgent,
  createTools,
  streamEvents,
} from './fakes.js';
import type { ProviderFinished } from 'llms';
import { createMessageStorage } from 'messages';
import { createToolStorage, defineTool } from 'tool';

test('complete executes requested tools and calls the provider again with tool results', async () => {
  const lookup = call('lookup', { query: 'doric' });
  const fake = createProvider({
    complete: (_request, index) =>
      index === 0
        ? completeFinish('Checking.', [lookup])
        : completeFinish('Tool says result.'),
  });
  const tools = createTools({ results: { lookup: { found: true } } });
  const messages = createMessageStorage();
  const agent = createAgent({
    provider: fake.provider,
    tools: tools.storage,
    messages,
    system: '',
    model: 'fake-model',
  });

  const response = await agent.complete('Find context.');

  assert.equal(response.text, 'Tool says result.');
  assert.equal(fake.requests.length, 2);
  assert.deepEqual(tools.calls, [
    { id: lookup.id, name: 'lookup', payload: { query: 'doric' } },
  ]);
  const stored = messages.list();
  assert.deepEqual(stored.slice(0, 2), [
    { role: 'user', content: 'Find context.' },
    {
      role: 'assistant',
      content: 'Checking.',
      toolCalls: [lookup],
    },
  ]);
  assert.equal(stored[2]?.role, 'tool');
  assert.equal(stored[2]?.toolCallId, lookup.id);
  assert.match(String(stored[2]?.content), /# Tool Result/u);
  assert.match(String(stored[2]?.content), /\{"found":true\}/u);
  assert.deepEqual(stored[3], {
    role: 'assistant',
    content: 'Tool says result.',
  });
  assert.deepEqual(fake.requests[1]?.messages, messages.list().slice(0, 3));
});

test('rejects an invalid tool-call batch before any handler executes', async () => {
  let executions = 0;
  const tools = createToolStorage(
    ['first', 'second'].map((name) =>
      defineTool({
        name,
        input: z.object({ value: z.string() }),
        output: z.string(),
        execute: (_sandbox, host, { value }) => {
          executions += 1;
          return value;
        },
      })(undefined as never, undefined as never),
    ),
  );
  const repairs: number[] = [];
  const fake = createProvider({
    complete: (_request, index) =>
      index === 0
        ? completeFinish('', [
            call('first', { value: 'valid' }),
            call('second', { value: 42 }),
          ])
        : completeFinish('Recovered.'),
  });
  const agent = createAgent({
    provider: fake.provider,
    tools,
    messages: createMessageStorage(),
    system: '',
    model: 'fake-model',
  });

  const response = await agent.complete('Run tools.', {
    onToolCallRepair: ({ attempt }) => {
      repairs.push(attempt);
    },
  });

  assert.equal(response.text, 'Recovered.');
  assert.equal(executions, 0);
  assert.deepEqual(repairs, [1]);
  assert.equal(
    fake.requests[1]?.messages.filter(
      ({ role, toolResultStatus }) =>
        role === 'tool' && toolResultStatus === 'incomplete',
    ).length,
    2,
  );
});

test('stream yields provider events tool events and final agent event across a tool loop', async () => {
  const lookup = call('lookup', { query: 'stream' });
  const fake = createProvider({
    stream: (_request, index) =>
      streamEvents(
        index === 0
          ? completeFinish('Need tool.', [lookup])
          : completeFinish('Stream done.'),
      ),
  });
  const tools = createTools({ results: { lookup: 'stream-result' } });
  const messages = createMessageStorage();
  const agent = createAgent({
    provider: fake.provider,
    tools: tools.storage,
    messages,
    system: 'Stream system.',
    model: 'fake-model',
  });

  const events = await collect(agent.stream('Stream input.'));

  assert.deepEqual(
    events.map((event) => event.type),
    [
      'agent.started',
      'response.started',
      'text.delta',
      'response.finished',
      'tool.started',
      'tool.finished',
      'response.started',
      'text.delta',
      'response.finished',
      'agent.finished',
    ],
  );
  assert.deepEqual(events[4], {
    type: 'tool.started',
    call: { id: lookup.id, name: 'lookup', payload: { query: 'stream' } },
  });
  const toolFinished = events[5];
  assert.equal(toolFinished?.type, 'tool.finished');
  if (toolFinished?.type !== 'tool.finished')
    assert.fail('Missing tool event.');
  assert.deepEqual(toolFinished.call, {
    id: lookup.id,
    name: 'lookup',
    payload: { query: 'stream' },
  });
  assert.equal(toolFinished.result, 'stream-result');
  assert.equal(toolFinished.record.output, 'stream-result');
  assert.match(toolFinished.content, new RegExp(toolFinished.record.id, 'u'));
  const final = events.at(-1);

  assert.equal(
    final?.type === 'agent.finished' ? final.response.text : undefined,
    'Stream done.',
  );
});

test('rejects concurrent runs with AgentErrorObject before storage mutation', async () => {
  let release!: (finish: ProviderFinished) => void;
  const pending = new Promise<ProviderFinished>((resolve) => {
    release = resolve;
  });
  const fake = createProvider({ complete: () => pending });
  const messages = createMessageStorage();
  const agent = createAgent({
    provider: fake.provider,
    tools: createTools().storage,
    messages,
    system: '',
    model: 'fake-model',
  });

  const first = agent.complete('First.');

  await assert.rejects(
    agent.complete('Second.'),
    (error: unknown) =>
      error instanceof AgentErrorObject && error.data.code === 'concurrent_run',
  );
  assert.deepEqual(messages.list(), [{ role: 'user', content: 'First.' }]);

  release(completeFinish('First done.'));
  await first;
});

test('stream yields tool.failed and propagates tool execution errors', async () => {
  const failure = new Error('tool failed');
  const lookup = call('lookup');
  const fake = createProvider({
    stream: () => streamEvents(completeFinish('Need tool.', [lookup])),
  });
  const agent = createAgent({
    provider: fake.provider,
    tools: createTools({ failure }).storage,
    messages: createMessageStorage(),
    system: '',
    model: 'fake-model',
  });
  const events: AgentEvent[] = [];

  await assert.rejects(
    async () => {
      for await (const event of agent.stream('Run tool.')) {
        events.push(event);
      }
    },
    (error: unknown) => error === failure,
  );

  assert.deepEqual(events.at(-1), {
    type: 'tool.failed',
    call: { id: lookup.id, name: 'lookup', payload: {} },
    error: failure,
  });
});

test('complete propagates provider errors unchanged', async () => {
  const failure = new Error('provider failed');
  const fake = createProvider({
    complete: () => {
      throw failure;
    },
  });
  const agent = createAgent({
    provider: fake.provider,
    tools: createTools().storage,
    messages: createMessageStorage(),
    system: '',
    model: 'fake-model',
  });

  await assert.rejects(
    agent.complete('Run provider.'),
    (error: unknown) => error === failure,
  );
});

test('stream propagates provider errors unchanged', async () => {
  const failure = new Error('provider stream failed');
  const fake = createProvider({
    stream: () => {
      throw failure;
    },
  });
  const agent = createAgent({
    provider: fake.provider,
    tools: createTools().storage,
    messages: createMessageStorage(),
    system: '',
    model: 'fake-model',
  });

  await assert.rejects(
    collect(agent.stream('Stream provider.')),
    (error: unknown) => error === failure,
  );
});

test('stream throws AgentErrorObject when the provider omits response.finished', async () => {
  const fake = createProvider({
    stream: () =>
      (async function* () {
        yield {
          type: 'text.delta',
          delta: 'unfinished',
        };
      })(),
  });
  const agent = createAgent({
    provider: fake.provider,
    tools: createTools().storage,
    messages: createMessageStorage(),
    system: '',
    model: 'fake-model',
  });

  await assert.rejects(
    collect(agent.stream('Unfinished.')),
    (error: unknown) =>
      error instanceof AgentErrorObject &&
      error.data.code === 'missing_provider_finish',
  );
});

test('serializes string object and undefined tool results into tool messages', async () => {
  const first = call('string');
  const second = call('object');
  const third = call('empty');
  const fake = createProvider({
    complete: (_request, index) =>
      index === 0
        ? completeFinish('Need tools.', [first, second, third])
        : completeFinish('Done.'),
  });
  const messages = createMessageStorage();
  const agent = createAgent({
    provider: fake.provider,
    tools: createTools({
      results: {
        string: 'plain text',
        object: { ok: true },
        empty: undefined,
      },
    }).storage,
    messages,
    system: '',
    model: 'fake-model',
  });

  await agent.complete('Serialize.');

  const results = messages.list().filter((message) => message.role === 'tool');
  assert.deepEqual(
    results.map(({ toolCallId }) => toolCallId),
    [first.id, second.id, third.id],
  );
  ['plain text', '{"ok":true}', '## Output'].forEach((output, index) =>
    assert.ok(String(results[index]?.content).includes(output)),
  );
});

test('throws AgentErrorObject when a tool result cannot be serialized', async () => {
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  const cycle = call('cycle');
  const fake = createProvider({
    complete: () => completeFinish('Need tool.', [cycle]),
  });
  const messages = createMessageStorage();
  const agent = createAgent({
    provider: fake.provider,
    tools: createTools({ results: { cycle: cyclic } }).storage,
    messages,
    system: '',
    model: 'fake-model',
  });

  await assert.rejects(
    agent.complete('Serialize cycle.'),
    (error: unknown) =>
      error instanceof AgentErrorObject &&
      error.data.code === 'tool_result_serialization_failed',
  );
  assert.deepEqual(
    messages
      .list()
      .filter(({ role }) => role === 'tool')
      .map(({ toolCallId, toolResultStatus }) => [
        toolCallId,
        toolResultStatus,
      ]),
    [['call_cycle', 'incomplete']],
  );
});

test('continues tool loops until the provider returns a final response', async () => {
  const fake = createProvider({
    complete: (_request, index) =>
      index < 3
        ? completeFinish(`Tool turn ${index}.`, [call('repeat', { index })])
        : completeFinish('Final after tools.'),
  });
  const tools = createTools({ results: { repeat: 'again' } });
  const agent = createAgent({
    provider: fake.provider,
    tools: tools.storage,
    messages: createMessageStorage(),
    system: '',
    model: 'fake-model',
  });

  const response = await agent.complete('Loop.');

  assert.equal(response.text, 'Final after tools.');
  assert.equal(fake.requests.length, 4);
  assert.equal(tools.calls.length, 3);
});
