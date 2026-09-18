import assert from 'node:assert/strict';
import test from 'node:test';

import { z } from 'zod';

import { createMessageStorage } from 'messages';

import { AgentErrorObject } from '../src/index.js';
import {
  call,
  collect,
  completeFinish,
  createProvider,
  createTestAgent as createAgent,
  createTools,
  streamEvents,
} from './fakes.js';

test('complete uses a terminal tool for structured output with empty tool storage', async () => {
  const schema = z.object({ answer: z.string() });

  const fake = createProvider({
    complete: (request) => {
      const terminal = request.tools?.[0];

      assert.equal(request.tools?.length, 1);

      assert.equal(terminal?.name, 'submit_structured_output');

      return completeFinish('', [
        call(terminal?.name ?? '', { answer: 'Done' }),
      ]);
    },
  });
  const messages = createMessageStorage();

  const agent = createAgent({
    provider: fake.provider,
    tools: createTools().storage,
    messages,
    system: '',
    model: 'fake-model',
  });
  const response = await agent.complete('Return JSON.', { schema });
  const structured: { readonly answer: string } | undefined =
    response.structured;
  // @ts-expect-error structured output is inferred from the Zod schema.
  const invalid: number | undefined = response.structured;

  void invalid;

  assert.equal(fake.requests[0]?.schema, undefined);

  assert.deepEqual(structured, { answer: 'Done' });

  assert.deepEqual(response.finish.toolCalls, []);

  assert.deepEqual(messages.list(), [
    { role: 'user', content: 'Return JSON.' },
    { role: 'assistant', content: '{"answer":"Done"}' },
  ]);
});

test('complete uses a terminal tool for structured output after executable tools', async () => {
  const schema = z.object({ answer: z.string() });
  const lookup = call('lookup', { query: 'doric' });

  const fake = createProvider({
    complete: (request, index) => {
      if (index === 0) {
        return completeFinish('', [lookup]);
      }

      const terminal = request.tools?.find(
        ({ description }) =>
          description ===
          'Submit the final structured output and end the agent run.',
      );

      assert.ok(terminal);

      return completeFinish('', [call(terminal.name, { answer: 'Done' })]);
    },
  });

  const tools = createTools({
    definitions: [
      {
        name: 'lookup',
        inputSchema: { type: 'object' },
        outputSchema: {},
        strict: true,
      },
      {
        name: 'submit_structured_output',
        inputSchema: { type: 'object' },
        outputSchema: { not: {} },
      },
    ],
    results: { lookup: { found: true } },
  });
  const messages = createMessageStorage();

  const agent = createAgent({
    provider: fake.provider,
    tools: tools.storage,
    messages,
    system: 'Use evidence.',
    model: 'fake-model',
  });
  const response = await agent.complete('Return evidence.', { schema });

  assert.deepEqual(response.structured, { answer: 'Done' });

  assert.equal(response.finish.toolCalls.length, 0);

  assert.equal(fake.requests.length, 2);

  assert.equal(fake.requests[0]?.schema, undefined);

  assert.equal(fake.requests[1]?.schema, undefined);

  assert.equal(fake.requests[0]?.tools?.length, 3);

  assert.equal(fake.requests[0]?.toolChoice, undefined);

  assert.equal(fake.requests[0]?.parallelToolCalls, false);

  assert.equal(
    fake.requests[0]?.tools?.find(
      ({ description }) =>
        description ===
        'Submit the final structured output and end the agent run.',
    )?.name,
    'submit_structured_output_2',
  );

  assert.deepEqual(tools.calls, [
    { id: lookup.id, name: 'lookup', payload: { query: 'doric' } },
  ]);
});

test('complete rejects terminal tool arguments that fail the output schema', async () => {
  const schema = z.object({ answer: z.string() });

  const fake = createProvider({
    complete: (request) => {
      const terminal = request.tools?.find(
        ({ description }) =>
          description ===
          'Submit the final structured output and end the agent run.',
      );

      assert.ok(terminal);

      return completeFinish('', [call(terminal.name, { answer: 42 })]);
    },
  });

  const agent = createAgent({
    provider: fake.provider,
    tools: createTools({
      definitions: [
        { name: 'lookup', inputSchema: { type: 'object' }, outputSchema: {} },
      ],
    }).storage,
    messages: createMessageStorage(),
    system: '',
    model: 'fake-model',
  });

  await assert.rejects(
    agent.complete('Return evidence.', { schema }),
    (error: unknown) =>
      error instanceof AgentErrorObject &&
      error.data.code === 'invalid_structured_output',
  );
});

test('complete rejects a text finish when a terminal structured output is required', async () => {
  const agent = createAgent({
    provider: createProvider({
      complete: () => completeFinish('Unstructured answer.'),
    }).provider,
    tools: createTools({
      definitions: [
        { name: 'lookup', inputSchema: { type: 'object' }, outputSchema: {} },
      ],
    }).storage,
    messages: createMessageStorage(),
    system: '',
    model: 'fake-model',
  });

  await assert.rejects(
    agent.complete('Return evidence.', {
      schema: z.object({ answer: z.string() }),
    }),
    (error: unknown) =>
      error instanceof AgentErrorObject &&
      error.data.code === 'invalid_structured_output',
  );
});

test('complete rejects terminal structured output mixed with executable calls', async () => {
  const fake = createProvider({
    complete: (request) => {
      const terminal = request.tools?.find(
        ({ description }) =>
          description ===
          'Submit the final structured output and end the agent run.',
      );

      assert.ok(terminal);

      return completeFinish('', [
        call('lookup'),
        call(terminal.name, { answer: 'Done' }),
      ]);
    },
  });

  const tools = createTools({
    definitions: [
      { name: 'lookup', inputSchema: { type: 'object' }, outputSchema: {} },
    ],
  });

  const agent = createAgent({
    provider: fake.provider,
    tools: tools.storage,
    messages: createMessageStorage(),
    system: '',
    model: 'fake-model',
  });

  await assert.rejects(
    agent.complete('Return evidence.', {
      schema: z.object({ answer: z.string() }),
    }),
    (error: unknown) =>
      error instanceof AgentErrorObject &&
      error.data.code === 'invalid_structured_output',
  );

  assert.deepEqual(tools.calls, []);
});

test('stream uses a terminal tool for structured output with empty tool storage', async () => {
  const schema = z.object({ answer: z.string() });

  const fake = createProvider({
    stream: (request) => {
      const terminal = request.tools?.[0];

      assert.equal(request.tools?.length, 1);

      assert.equal(terminal?.name, 'submit_structured_output');

      return streamEvents(
        completeFinish('', [call(terminal?.name ?? '', { answer: 'Done' })]),
      );
    },
  });
  const messages = createMessageStorage();

  const agent = createAgent({
    provider: fake.provider,
    tools: createTools().storage,
    messages,
    system: '',
    model: 'fake-model',
  });
  const events = await collect(agent.stream('Return JSON.', { schema }));
  const final = events.at(-1);

  assert.equal(fake.requests[0]?.schema, undefined);

  assert.equal(final?.type, 'agent.finished');

  if (final?.type !== 'agent.finished') {
    assert.fail('Expected final agent.finished event.');
  }

  assert.deepEqual(final.response.structured, { answer: 'Done' });

  assert.deepEqual(messages.list(), [
    { role: 'user', content: 'Return JSON.' },
    { role: 'assistant', content: '{"answer":"Done"}' },
  ]);
});

test('stream uses a terminal tool for structured output after executable tools', async () => {
  const schema = z.object({ answer: z.string() });
  const lookup = call('lookup', { query: 'stream' });

  const fake = createProvider({
    stream: (request, index) => {
      if (index === 0) {
        return streamEvents(completeFinish('', [lookup]));
      }

      const terminal = request.tools?.find(
        ({ description }) =>
          description ===
          'Submit the final structured output and end the agent run.',
      );

      assert.ok(terminal);

      return streamEvents(
        completeFinish('', [call(terminal.name, { answer: 'Done' })]),
      );
    },
  });

  const tools = createTools({
    definitions: [
      { name: 'lookup', inputSchema: { type: 'object' }, outputSchema: {} },
    ],
    results: { lookup: 'evidence' },
  });

  const agent = createAgent({
    provider: fake.provider,
    tools: tools.storage,
    messages: createMessageStorage(),
    system: '',
    model: 'fake-model',
  });
  const events = await collect(agent.stream('Return evidence.', { schema }));
  const final = events.at(-1);

  assert.equal(final?.type, 'agent.finished');

  if (final?.type !== 'agent.finished') {
    return;
  }

  assert.deepEqual(final.response.structured, { answer: 'Done' });

  assert.equal(final.response.finish.toolCalls.length, 0);

  assert.equal(fake.requests[0]?.schema, undefined);

  assert.equal(fake.requests[1]?.schema, undefined);

  assert.deepEqual(tools.calls, [
    { id: lookup.id, name: 'lookup', payload: { query: 'stream' } },
  ]);
});
