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
            usage: {
              input_tokens: 3,
              cache_read_input_tokens: 50,
              output_tokens: 1,
            },
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
          usage: { input_tokens: null, output_tokens: 12 },
        }),
        sse({ type: 'message_stop' }),
      ],
    ],
  });

  const events: readonly ProviderStreamEvent[] = await collect(
    provider(transport).stream(request),
  );

  const messages = transport.requests.find(({ url }) =>
    url.endsWith('/v1/messages?beta=true'),
  );

  assert.equal(
    messages?.url,
    'https://api.anthropic.com/v1/messages?beta=true',
  );

  assert.equal(messages?.headers?.accept, 'text/event-stream');

  // A stream has room for a long thinking turn.
  assert.equal(
    (JSON.parse(messages?.body ?? '{}') as { max_tokens?: number }).max_tokens,
    64000,
  );

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
      // Each event carries every count reported so far: the delta's output
      // count joins the start's input and cache counts, it does not replace
      // them, and its `null` input count erases nothing. The input count is
      // the whole prompt, cache reads included.
      {
        type: 'usage',
        usage: {
          inputTokens: 53,
          outputTokens: 1,
          cachedInputTokens: 50,
          totalTokens: 54,
        },
      },
      {
        type: 'usage',
        usage: {
          inputTokens: 53,
          outputTokens: 12,
          cachedInputTokens: 50,
          totalTokens: 65,
        },
      },
    ],
  );

  const finished = events.at(-1);

  assert.equal(finished?.type, 'response.finished');

  if (finished?.type !== 'response.finished') {
    assert.fail('Expected final response.finished event.');
  }

  assert.equal(finished.finish.text, 'Hello');

  assert.equal(finished.finish.finishReason, 'stop');

  assert.equal(finished.finish.usage?.inputTokens, 53);

  assert.equal(finished.finish.usage?.outputTokens, 12);

  assert.equal(finished.finish.usage?.totalTokens, 65);
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
  // The error keeps Anthropic's type and message, and an overload is worth
  // a retry.
  assert.equal(failure.error.code, 'overloaded_error');
  assert.match(failure.error.message, /Overloaded/);
  assert.equal(failure.error.retryable, true);
});

void test('routes thinking to reasoning and keeps the signed turn as its replay', async () => {
  const transport = fakeTransport({
    streams: [
      [
        sse({
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'thinking', thinking: '', signature: '' },
        }),
        sse({
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'thinking_delta', thinking: 'Let me think.' },
        }),
        sse({
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'signature_delta', signature: 'sig-1' },
        }),
        sse({ type: 'content_block_stop', index: 0 }),
        sse({
          type: 'content_block_start',
          index: 1,
          content_block: { type: 'text', text: '' },
        }),
        sse({
          type: 'content_block_delta',
          index: 1,
          delta: { type: 'text_delta', text: 'Hi' },
        }),
        sse({ type: 'content_block_stop', index: 1 }),
        sse({
          type: 'message_delta',
          delta: { stop_reason: 'end_turn' },
          usage: {
            output_tokens: 30,
            output_tokens_details: { thinking_tokens: 20 },
          },
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

  if (finished?.type !== 'response.finished') {
    assert.fail('Expected final response.finished event.');
  }

  assert.equal(finished.finish.text, 'Hi');
  assert.equal(finished.finish.reasoning?.text, 'Let me think.');
  assert.equal(finished.finish.usage?.reasoningTokens, 20);
  // The turn goes back as it was, signature included.
  assert.deepEqual(finished.finish.replay, [
    {
      provider: 'claude',
      block: {
        type: 'thinking',
        thinking: 'Let me think.',
        signature: 'sig-1',
      },
    },
    { provider: 'claude', block: { type: 'text', text: 'Hi' } },
  ]);
});

const finishOf = (events: readonly ProviderStreamEvent[]) => {
  const finished = events.at(-1);
  if (finished?.type !== 'response.finished') {
    assert.fail('Expected final response.finished event.');
  }
  return finished.finish;
};

const toolStart = (index: number, id: string) =>
  sse({
    type: 'content_block_start',
    index,
    content_block: { type: 'tool_use', id, name: 'write', input: {} },
  });

const toolJson = (index: number, partial_json: string) =>
  sse({
    type: 'content_block_delta',
    index,
    delta: { type: 'input_json_delta', partial_json },
  });

void test('a max_tokens stop never makes a call of the tool block it cut off', async () => {
  const transport = fakeTransport({
    streams: [
      [
        toolStart(0, 'toolu_1'),
        toolJson(0, '{"path":"a.txt"}'),
        sse({ type: 'content_block_stop', index: 0 }),
        toolStart(1, 'toolu_2'),
        toolJson(1, '{"path":"b.txt","content":"hel'),
        sse({ type: 'content_block_stop', index: 1 }),
        sse({ type: 'message_delta', delta: { stop_reason: 'max_tokens' } }),
        sse({ type: 'message_stop' }),
      ],
    ],
  });

  const events = await collect(provider(transport).stream(request));
  const finish = finishOf(events);

  assert.equal(finish.finishReason, 'length');
  assert.deepEqual(
    finish.toolCalls.map((call) => call.id),
    ['toolu_1'],
  );
  assert.deepEqual(
    events
      .filter(
        (event): event is ProviderStreamEvent & { type: 'tool_call.done' } =>
          event.type === 'tool_call.done',
      )
      .map((event) => event.call.id),
    ['toolu_1'],
  );
});

void test('a full context window is a cut-off answer', async () => {
  const transport = fakeTransport({
    streams: [
      [
        sse({
          type: 'message_delta',
          delta: { stop_reason: 'model_context_window_exceeded' },
        }),
        sse({ type: 'message_stop' }),
      ],
    ],
  });

  const finish = finishOf(await collect(provider(transport).stream(request)));

  assert.equal(finish.finishReason, 'length');
});

void test('a refused stream keeps no text or calls and says why', async () => {
  const transport = fakeTransport({
    streams: [
      [
        sse({
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'text', text: '' },
        }),
        sse({
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: 'Sure, the exploit works by' },
        }),
        sse({ type: 'content_block_stop', index: 0 }),
        toolStart(1, 'toolu_1'),
        toolJson(1, '{}'),
        sse({ type: 'content_block_stop', index: 1 }),
        sse({
          type: 'message_delta',
          delta: {
            stop_reason: 'refusal',
            stop_details: { type: 'refusal', category: 'cyber' },
          },
        }),
        sse({ type: 'message_stop' }),
      ],
    ],
  });

  const finish = finishOf(await collect(provider(transport).stream(request)));

  assert.equal(finish.finishReason, 'content_filter');
  assert.equal(finish.text, '');
  assert.deepEqual(finish.toolCalls, []);
  assert.equal(finish.replay, undefined);
  assert.equal(finish.refusal, 'Claude declined to answer (cyber).');
});

void test('a stream cut short is a retryable error, never a finished answer', async () => {
  const transport = fakeTransport({
    streams: [
      [
        sse({
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: 'I will now' },
        }),
        toolStart(1, 'toolu_1'),
      ],
    ],
  });

  const events = await collect(provider(transport).stream(request));
  const last = events.at(-1);

  assert.equal(
    events.some(({ type }) => type === 'response.finished'),
    false,
  );
  if (last?.type !== 'error') {
    assert.fail('Expected an error event.');
  }
  assert.equal(last.error.code, 'incomplete_stream');
  assert.equal(last.error.retryable, true);
});

void test('a stream reports the context window the catalog lists for its model', async () => {
  const transport = fakeTransport({
    responses: [
      {
        status: 200,
        headers: {},
        body: JSON.stringify({
          data: [
            { id: 'claude-sonnet-4-5-20250929', max_input_tokens: 200000 },
          ],
          has_more: false,
        }),
      },
    ],
    streams: [[sse({ type: 'message_stop' })], [sse({ type: 'message_stop' })]],
  });
  const claude = provider(transport);

  const first = await collect(claude.stream(request));
  const second = await collect(claude.stream(request));

  assert.deepEqual(first[0], {
    type: 'response.started',
    provider: 'claude',
    model: 'claude-sonnet-4-5',
    contextWindow: 200000,
  });
  assert.deepEqual(second[0], first[0]);
  // The catalog is read once per provider.
  assert.equal(
    transport.requests.filter(({ url }) => url.includes('/v1/models')).length,
    1,
  );
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
