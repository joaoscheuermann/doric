import assert from 'node:assert/strict';
import test from 'node:test';

import { z } from 'zod';

import { ProviderErrorObject, type ProviderStreamEvent } from '../src/index.js';
import {
  collect,
  createOpenRouterProvider,
  fakeTransport,
  response,
} from './fakes.js';

test('streams OpenRouter deltas usage finish and accumulated tool calls', async () => {
  const provider = createOpenRouterProvider({
    transport: fakeTransport({
      streams: [
        [
          sse({ choices: [{ delta: { content: 'Hi' } }] }),
          sse({ choices: [{ delta: { reasoning: 'why' } }] }),
          sse({
            choices: [
              {
                delta: {
                  reasoning_details: [
                    { type: 'reasoning.encrypted', data: 'opaque-1' },
                    { type: 'reasoning.text', text: 'hidden' },
                  ],
                },
              },
            ],
          }),
          sse({ choices: [{ delta: { refusal: 'no' } }] }),
          sse({
            choices: [
              {
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: 'call_1',
                      function: { name: 'lookup', arguments: '{"q"' },
                    },
                  ],
                },
              },
            ],
          }),
          sse({
            choices: [
              {
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      function: { arguments: ':"x"}' },
                    },
                  ],
                },
                finish_reason: 'tool_calls',
              },
            ],
            usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
          }),
          'data: [DONE]\n\n',
        ],
      ],
    }),
    apiKey: 'key',
  });

  const events = await collect(
    provider.stream({
      model: 'openai/gpt-5',
      messages: [{ role: 'user', content: 'Hi' }],
      schema: z.object({ answer: z.string() }),
    }),
  );
  const finished = events.at(-1);

  const expectedToolCalls = [
    { id: 'call_1', name: 'lookup', arguments: '{"q":"x"}', index: 0 },
  ];

  assert.equal(events[0]?.type, 'response.started');

  assert.deepEqual(
    events
      .filter(
        (
          event,
        ): event is Extract<ProviderStreamEvent, { type: 'text.delta' }> =>
          event.type === 'text.delta',
      )
      .map((event) => event.delta),
    ['Hi'],
  );

  assert.deepEqual(
    events
      .filter(
        (
          event,
        ): event is Extract<ProviderStreamEvent, { type: 'reasoning.delta' }> =>
          event.type === 'reasoning.delta',
      )
      .map((event) => event.delta),
    ['why'],
  );

  assert.deepEqual(
    events
      .filter(
        (
          event,
        ): event is Extract<ProviderStreamEvent, { type: 'refusal.delta' }> =>
          event.type === 'refusal.delta',
      )
      .map((event) => event.delta),
    ['no'],
  );

  assert.ok(events.some((event) => event.type === 'usage'));

  assert.deepEqual(
    events
      .filter(
        (event): event is ProviderStreamEvent & { type: 'tool_call.done' } =>
          event.type === 'tool_call.done',
      )
      .map((event) => event.call),
    expectedToolCalls,
  );

  assert.equal(finished?.type, 'response.finished');

  if (finished?.type !== 'response.finished') {
    assert.fail('Expected final response.finished event.');
  }

  assert.equal(finished.finish.text, 'Hi');

  assert.deepEqual(finished.finish.reasoning, { text: 'why' });

  assert.deepEqual(finished.finish.replay, [
    { type: 'reasoning.encrypted', data: 'opaque-1' },
    { type: 'reasoning.text', text: 'hidden' },
  ]);

  assert.equal(finished.finish.refusal, 'no');

  assert.equal(finished.finish.finishReason, 'tool_calls');

  assert.deepEqual(finished.finish.toolCalls, expectedToolCalls);

  assert.equal(finished.finish.structured, undefined);
});

test('allows OpenRouter structured output from stream finishes without parsing', async () => {
  const provider = createOpenRouterProvider({
    transport: fakeTransport({
      streams: [
        [
          sse({ choices: [{ delta: { content: '{"answer"' } }] }),
          sse({
            choices: [
              { delta: { content: ':"Done"}' }, finish_reason: 'stop' },
            ],
          }),
          'data: [DONE]\n\n',
        ],
      ],
    }),
    apiKey: 'key',
  });

  const events = await collect(
    provider.stream({
      model: 'openai/gpt-5',
      messages: [{ role: 'user', content: 'Hi' }],
      schema: z.object({ answer: z.string() }),
    }),
  );
  const finished = events.at(-1);

  assert.equal(finished?.type, 'response.finished');

  if (finished?.type !== 'response.finished') {
    assert.fail('Expected final response.finished event.');
  }

  assert.equal(finished.finish.structured, undefined);
});

test('allows invalid OpenRouter structured JSON from streams', async () => {
  const completeProvider = createOpenRouterProvider({
    transport: fakeTransport({
      responses: [
        response({
          choices: [
            {
              finish_reason: 'stop',
              message: { content: 'not-json' },
            },
          ],
        }),
      ],
    }),
    apiKey: 'key',
  });

  const streamProvider = createOpenRouterProvider({
    transport: fakeTransport({
      streams: [
        [
          sse({
            choices: [
              { delta: { content: 'not-json' }, finish_reason: 'stop' },
            ],
          }),
          'data: [DONE]\n\n',
        ],
      ],
    }),
    apiKey: 'key',
  });

  const request = {
    model: 'openai/gpt-5',
    messages: [{ role: 'user', content: 'Hi' }],
    schema: z.object({ answer: z.string() }),
  } as const;

  await assert.rejects(
    completeProvider.complete(request),
    (error: unknown) =>
      error instanceof ProviderErrorObject &&
      error.data.code === 'invalid_structured_output',
  );

  const events = await collect(streamProvider.stream(request));
  const finished = events.at(-1);

  assert.equal(finished?.type, 'response.finished');

  if (finished?.type !== 'response.finished') {
    assert.fail('Expected final response.finished event.');
  }

  assert.equal(finished.finish.text, 'not-json');

  assert.equal(finished.finish.structured, undefined);
});

test('returns OpenRouter stream error events for malformed and provider errors', async () => {
  const malformed = createOpenRouterProvider({
    transport: fakeTransport({ streams: [['data: not-json\n\n']] }),
    apiKey: 'key',
  });

  const providerError = createOpenRouterProvider({
    transport: fakeTransport({
      streams: [[sse({ error: { message: 'bad' } })]],
    }),
    apiKey: 'key',
  });

  assert.equal(
    (
      await collect(
        malformed.stream({
          model: 'openai/gpt-5',
          messages: [{ role: 'user', content: 'Hi' }],
        }),
      )
    ).at(-1)?.type,
    'error',
  );

  assert.equal(
    (
      await collect(
        providerError.stream({
          model: 'openai/gpt-5',
          messages: [{ role: 'user', content: 'Hi' }],
        }),
      )
    ).at(-1)?.type,
    'error',
  );
});

const sse = (value: unknown): string => `data: ${JSON.stringify(value)}\n\n`;
