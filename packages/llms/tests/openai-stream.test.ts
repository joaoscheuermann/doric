import assert from 'node:assert/strict';
import test from 'node:test';

import { z } from 'zod';

import { type ProviderStreamEvent } from '../src/index.js';
import { collect, createOpenAiProvider, fakeTransport } from './fakes.js';

test('streams OpenAI requests without an authorization header when credentials are omitted', async () => {
  const transport = fakeTransport({
    streams: [
      [
        sse({
          type: 'response.completed',
          response: {
            status: 'completed',
            output_text: 'ok',
          },
        }),
      ],
    ],
  });

  const provider = createOpenAiProvider({
    transport,
  });

  const events = await collect(
    provider.stream({
      model: 'gpt-5',
      messages: [{ role: 'user', content: 'Hi' }],
    }),
  );

  assert.equal(events[0]?.type, 'response.started');

  assert.equal(events.at(-1)?.type, 'response.finished');

  assert.equal(
    'authorization' in (transport.requests[0]?.headers ?? {}),
    false,
  );
});

test('streams OpenAI text reasoning usage finish and tool calls', async () => {
  const stream = [
    sse({ type: 'response.output_text.delta', delta: 'Hel' }),
    sse({ type: 'response.output_text.delta', delta: 'lo' }),
    sse({ type: 'response.reasoning_summary_text.delta', delta: 'why' }),
    sse({
      type: 'response.function_call_arguments.delta',
      output_index: 0,
      item_id: 'call_1',
      name: 'lookup',
      delta: '{"q"',
    }),
    sse({
      type: 'response.function_call_arguments.delta',
      output_index: 0,
      delta: ':"x"}',
    }),
    sse({
      type: 'response.output_item.done',
      output_index: 0,
      item: {
        type: 'function_call',
        call_id: 'call_1',
        name: 'lookup',
        arguments: '{"q":"x"}',
      },
    }),
    sse({
      type: 'response.completed',
      response: {
        status: 'completed',
        output_text: 'Hello',
        output: [
          { type: 'reasoning', encrypted_content: 'opaque' },
          {
            type: 'function_call',
            call_id: 'call_1',
            name: 'lookup',
            arguments: '{"q":"x"}',
          },
        ],
        usage: { input_tokens: 1, output_tokens: 2, total_tokens: 3 },
      },
    }),
  ];

  const provider = createOpenAiProvider({
    transport: fakeTransport({ streams: [stream] }),
    apiKey: 'sk-testSecret123',
  });

  const events = await collect(
    provider.stream({
      model: 'gpt-5',
      messages: [{ role: 'user', content: 'Hi' }],
      schema: z.object({ answer: z.string() }),
    }),
  );

  assert.equal(events[0]?.type, 'response.started');

  assert.deepEqual(
    events
      .filter(
        (event): event is ProviderStreamEvent & { type: 'text.delta' } =>
          event.type === 'text.delta',
      )
      .map((event) => event.delta),
    ['Hel', 'lo'],
  );

  assert.ok(events.some((event) => event.type === 'reasoning.delta'));

  assert.ok(events.some((event) => event.type === 'tool_call.done'));

  assert.ok(events.some((event) => event.type === 'usage'));

  const finished = events.at(-1);

  assert.equal(finished?.type, 'response.finished');

  if (finished?.type !== 'response.finished') {
    assert.fail('Expected final response.finished event.');
  }

  assert.equal(finished.finish.structured, undefined);

  assert.deepEqual(finished.finish.replay, [
    { type: 'reasoning', encrypted_content: 'opaque' },
    {
      type: 'function_call',
      call_id: 'call_1',
      name: 'lookup',
      arguments: '{"q":"x"}',
    },
  ]);
});

test('keeps streamed OpenAI tool calls from completed responses without output', async () => {
  const stream = [
    sse({
      type: 'response.function_call_arguments.delta',
      output_index: 0,
      item_id: 'call_1',
      name: 'lookup',
      delta: '{"q"',
    }),
    sse({
      type: 'response.function_call_arguments.delta',
      output_index: 0,
      delta: ':"x"}',
    }),
    sse({
      type: 'response.output_item.done',
      output_index: 0,
      item: {
        type: 'function_call',
        call_id: 'call_1',
        name: 'lookup',
        arguments: '{"q":"x"}',
      },
    }),
    sse({
      type: 'response.completed',
      response: {
        status: 'completed',
      },
    }),
  ];

  const provider = createOpenAiProvider({
    transport: fakeTransport({ streams: [stream] }),
    apiKey: 'sk-testSecret123',
  });

  const events = await collect(
    provider.stream({
      model: 'gpt-5',
      messages: [{ role: 'user', content: 'Hi' }],
    }),
  );
  const finished = events.at(-1);

  assert.equal(finished?.type, 'response.finished');

  if (finished?.type !== 'response.finished') {
    assert.fail('Expected final response.finished event.');
  }

  assert.deepEqual(finished.finish.toolCalls, [
    { id: 'call_1', name: 'lookup', arguments: '{"q":"x"}', index: 0 },
  ]);

  assert.equal(finished.finish.structured, undefined);
});

test('returns stream error event for malformed OpenAI stream payloads', async () => {
  const provider = createOpenAiProvider({
    transport: fakeTransport({ streams: [['data: not-json\n\n']] }),
    apiKey: 'sk-testSecret123',
  });

  const events = await collect(
    provider.stream({
      model: 'gpt-5',
      messages: [{ role: 'user', content: 'Hi' }],
    }),
  );

  assert.equal(events.at(-1)?.type, 'error');
});

const sse = (value: unknown): string => `data: ${JSON.stringify(value)}\n\n`;
