import assert from 'node:assert/strict';
import test from 'node:test';

import type { ProviderRequest, ProviderStreamEvent } from '../src/index.js';
import { createClaudeProvider } from '../src/index.js';
import { collect, fakeTransport, silentLogger } from './fakes.js';

const provider = (transport: ReturnType<typeof fakeTransport>) =>
  createClaudeProvider({
    transport,
    authorization: 'Bearer claude-token',
    logger: silentLogger,
  });

const request: ProviderRequest = {
  model: 'claude-sonnet-4-5',
  messages: [{ role: 'user', content: 'Hi' }],
};

const sse = (payload: unknown): string =>
  `data: ${JSON.stringify(payload)}\n\n`;

void test('streams text deltas to a finished response', async () => {
  const transport = fakeTransport({
    streams: [
      [
        sse({
          type: 'message_start',
          message: {
            id: 'msg_1',
            role: 'assistant',
            usage: { input_tokens: 3 },
          },
        }),
        sse({
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: 'Hel' },
        }),
        sse({
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: 'lo' },
        }),
        sse({
          type: 'message_delta',
          delta: { stop_reason: 'end_turn', stop_sequence: null },
          usage: { output_tokens: 12 },
        }),
        sse({ type: 'message_stop' }),
      ],
    ],
  });

  const events: readonly ProviderStreamEvent[] = await collect(
    provider(transport).stream(request),
  );

  assert.equal(
    transport.requests[0]?.url,
    'https://api.anthropic.com/v1/messages?beta=true',
  );

  assert.equal(transport.requests[0]?.headers?.accept, 'text/event-stream');

  assert.deepEqual(events[0], {
    type: 'response.started',
    provider: 'claude',
    model: 'claude-sonnet-4-5',
  } satisfies ProviderStreamEvent);

  assert.deepEqual(
    events
      .filter(
        (event): event is ProviderStreamEvent & { type: 'text.delta' } =>
          event.type === 'text.delta',
      )
      .map((event) => event.delta),
    ['Hel', 'lo'],
  );

  assert.deepEqual(
    events.filter(
      (event): event is ProviderStreamEvent & { type: 'usage' } =>
        event.type === 'usage',
    ),
    [
      { type: 'usage', usage: { inputTokens: 3, totalTokens: 3 } },
      { type: 'usage', usage: { outputTokens: 12, totalTokens: 12 } },
    ],
  );

  const finished = events.at(-1);

  assert.equal(finished?.type, 'response.finished');

  if (finished?.type !== 'response.finished') {
    assert.fail('Expected final response.finished event.');
  }

  assert.equal(finished.finish.text, 'Hello');

  assert.equal(finished.finish.finishReason, 'stop');

  assert.equal(finished.finish.usage?.inputTokens, 3);

  assert.equal(finished.finish.usage?.outputTokens, 12);
});

void test('streams tool_use blocks as tool call deltas and done events', async () => {
  const transport = fakeTransport({
    streams: [
      [
        sse({
          type: 'content_block_start',
          index: 0,
          content_block: {
            type: 'tool_use',
            id: 'toolu_1',
            name: 'lookup',
            input: {},
          },
        }),
        sse({
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'input_json_delta', partial_json: '{"query"' },
        }),
        sse({
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'input_json_delta', partial_json: ':"x"}' },
        }),
        sse({ type: 'content_block_stop', index: 0 }),
        sse({
          type: 'content_block_start',
          index: 1,
          content_block: {
            type: 'tool_use',
            id: 'toolu_2',
            name: 'probe',
            input: {},
          },
        }),
        sse({ type: 'content_block_stop', index: 1 }),
        sse({ type: 'message_stop' }),
      ],
    ],
  });

  const events: readonly ProviderStreamEvent[] = await collect(
    provider(transport).stream(request),
  );

  assert.deepEqual(
    events
      .filter(
        (event): event is ProviderStreamEvent & { type: 'tool_call.delta' } =>
          event.type === 'tool_call.delta',
      )
      .map((event) => [event.index, event.argumentsDelta]),
    [
      [0, '{"query"'],
      [0, ':"x"}'],
    ],
  );

  assert.deepEqual(
    events
      .filter(
        (event): event is ProviderStreamEvent & { type: 'tool_call.done' } =>
          event.type === 'tool_call.done',
      )
      .map((event) => event.call),
    [
      { id: 'toolu_1', name: 'lookup', arguments: '{"query":"x"}', index: 0 },
      { id: 'toolu_2', name: 'probe', arguments: '{}', index: 1 },
    ],
  );

  const finished = events.at(-1);

  assert.equal(finished?.type, 'response.finished');

  if (finished?.type !== 'response.finished') {
    assert.fail('Expected final response.finished event.');
  }

  assert.deepEqual(finished.finish.toolCalls, [
    { id: 'toolu_1', name: 'lookup', arguments: '{"query":"x"}', index: 0 },
    { id: 'toolu_2', name: 'probe', arguments: '{}', index: 1 },
  ]);
});

void test('reports a mid-stream Anthropic error and stops', async () => {
  const transport = fakeTransport({
    streams: [
      [
        sse({
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: 'Hi' },
        }),
        sse({
          type: 'error',
          error: { type: 'overloaded_error', message: 'Overloaded' },
        }),
      ],
    ],
  });

  const events: readonly ProviderStreamEvent[] = await collect(
    provider(transport).stream(request),
  );

  assert.equal(events.at(-1)?.type, 'error');

  assert.equal(
    events.some(({ type }) => type === 'response.finished'),
    false,
  );

  const failure = events.at(-1);

  if (failure?.type !== 'error') {
    assert.fail('Expected an error event.');
  }

  assert.equal(failure.error.provider, 'claude');
});

void test('routes thinking deltas to reasoning, never to text', async () => {
  const transport = fakeTransport({
    streams: [
      [
        sse({
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'thinking_delta', thinking: 'Let me think.' },
        }),
        sse({
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: 'Hi' },
        }),
        sse({ type: 'message_stop' }),
      ],
    ],
  });

  const events: readonly ProviderStreamEvent[] = await collect(
    provider(transport).stream(request),
  );

  assert.deepEqual(
    events.filter((event) => event.type === 'reasoning.delta'),
    [{ type: 'reasoning.delta', delta: 'Let me think.' }],
  );

  assert.deepEqual(
    events
      .filter(
        (event): event is ProviderStreamEvent & { type: 'text.delta' } =>
          event.type === 'text.delta',
      )
      .map((event) => event.delta),
    ['Hi'],
  );

  const finished = events.at(-1);

  assert.equal(finished?.type, 'response.finished');

  if (finished?.type !== 'response.finished') {
    assert.fail('Expected final response.finished event.');
  }

  assert.equal(finished.finish.text, 'Hi');

  assert.equal(finished.finish.reasoning?.text, 'Let me think.');

  assert.equal(finished.finish.finishReason, 'unknown');
});

void test('ignores ping events', async () => {
  const transport = fakeTransport({
    streams: [[sse({ type: 'ping' }), sse({ type: 'message_stop' })]],
  });

  const events: readonly ProviderStreamEvent[] = await collect(
    provider(transport).stream(request),
  );

  assert.deepEqual(
    events.map((event) => event.type),
    ['response.started', 'response.finished'],
  );
});
