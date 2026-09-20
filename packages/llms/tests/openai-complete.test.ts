import assert from 'node:assert/strict';
import test from 'node:test';

import { z } from 'zod';

import { ProviderErrorObject } from '../src/index.js';
import { createOpenAiProvider, fakeTransport, response } from './fakes.js';

test('rejects OpenAI requests that are missing model or input', async () => {
  const provider = createOpenAiProvider({
    transport: fakeTransport({}),
    apiKey: 'sk-testSecret123',
  });

  await assert.rejects(
    provider.complete({
      model: '',
      messages: [{ role: 'user', content: 'hi' }],
    }),
    (error: unknown) =>
      error instanceof ProviderErrorObject &&
      error.data.code === 'missing_model',
  );

  await assert.rejects(
    provider.complete({ model: 'gpt-5', messages: [] }),
    (error: unknown) =>
      error instanceof ProviderErrorObject &&
      error.data.code === 'missing_input',
  );
});

test('parses OpenAI completion output usage reasoning and tool calls', async () => {
  const transport = fakeTransport({
    responses: [
      response({
        status: 'completed',
        output_text: 'Done',
        output: [
          { type: 'reasoning', summary: [{ text: 'Thought' }] },
          {
            type: 'function_call',
            call_id: 'call_1',
            name: 'lookup',
            arguments: '{"q":"x"}',
          },
        ],
        usage: {
          input_tokens: 3,
          output_tokens: 4,
          total_tokens: 7,
          output_tokens_details: { reasoning_tokens: 2 },
        },
      }),
    ],
  });

  const provider = createOpenAiProvider({
    transport,
    apiKey: 'sk-testSecret123',
  });

  const result = await provider.complete({
    model: 'gpt-5',
    messages: [{ role: 'user', content: 'Hi' }],
  });

  assert.equal(result.text, 'Done');

  assert.equal(result.finishReason, 'tool_calls');

  assert.deepEqual(result.reasoning, { text: 'Thought' });

  assert.deepEqual(result.usage, {
    inputTokens: 3,
    outputTokens: 4,
    totalTokens: 7,
    reasoningTokens: 2,
    cachedInputTokens: undefined,
  });

  assert.deepEqual(result.toolCalls, [
    { id: 'call_1', name: 'lookup', arguments: '{"q":"x"}', index: 0 },
  ]);

  assert.deepEqual(result.replay, [
    { type: 'reasoning', summary: [{ text: 'Thought' }] },
    {
      type: 'function_call',
      call_id: 'call_1',
      name: 'lookup',
      arguments: '{"q":"x"}',
    },
  ]);
});

test('returns parsed OpenAI structured output from completions', async () => {
  const transport = fakeTransport({
    responses: [
      response({
        status: 'completed',
        output_text: '{"answer":4}',
        output: [],
      }),
    ],
  });

  const provider = createOpenAiProvider({
    transport,
    apiKey: 'sk-testSecret123',
  });

  const result = await provider.complete({
    model: 'gpt-5',
    messages: [{ role: 'user', content: 'Hi' }],
    schema: z.object({ answer: z.coerce.number() }),
  });
  const answer: number = result.structured.answer;

  assert.deepEqual(result.structured, { answer: 4 });

  assert.equal(answer, 4);
});

test('returns parsed OpenAI nested union structured output from completions', async () => {
  const transport = fakeTransport({
    responses: [
      response({
        status: 'completed',
        output_text: '{"action":{"type":"answer","answer":"Done"}}',
        output: [],
      }),
    ],
  });

  const provider = createOpenAiProvider({
    transport,
    apiKey: 'sk-testSecret123',
  });

  const result = await provider.complete({
    model: 'gpt-5',
    messages: [{ role: 'user', content: 'Hi' }],
    schema: z.object({
      action: z.union([
        z.object({ type: z.literal('question'), question: z.string() }),
        z.object({ type: z.literal('answer'), answer: z.string() }),
      ]),
    }),
  });

  assert.deepEqual(result.structured, {
    action: { type: 'answer', answer: 'Done' },
  });
});

test('rejects OpenAI top-level discriminated union structured output from completions', async () => {
  const provider = createOpenAiProvider({
    transport: fakeTransport({}),
    apiKey: 'sk-testSecret123',
  });

  await assert.rejects(
    provider.complete({
      model: 'gpt-5',
      messages: [{ role: 'user', content: 'Hi' }],
      schema: z.discriminatedUnion('type', [
        z.object({ type: z.literal('question'), question: z.string() }),
        z.object({ type: z.literal('answer'), answer: z.string() }),
      ]),
    }),
    (error: unknown) =>
      error instanceof ProviderErrorObject &&
      error.data.code === 'invalid_structured_schema',
  );
});

test('rejects OpenAI refusals when structured output is required', async () => {
  const transport = fakeTransport({
    responses: [
      response({
        status: 'completed',
        output: [
          {
            type: 'message',
            content: [{ type: 'refusal', refusal: 'No.' }],
          },
        ],
      }),
    ],
  });

  const provider = createOpenAiProvider({
    transport,
    apiKey: 'sk-testSecret123',
  });

  await assert.rejects(
    provider.complete({
      model: 'gpt-5',
      messages: [{ role: 'user', content: 'Hi' }],
      schema: z.object({ answer: z.string() }),
    }),
    (error: unknown) =>
      error instanceof ProviderErrorObject &&
      error.data.code === 'invalid_structured_output',
  );
});

test('rejects OpenAI tool calls when structured output is required', async () => {
  const provider = createOpenAiProvider({
    transport: fakeTransport({
      responses: [
        response({
          status: 'completed',
          output: [
            {
              type: 'function_call',
              call_id: 'call_1',
              name: 'lookup',
              arguments: '{"q":"x"}',
            },
          ],
        }),
      ],
    }),
    apiKey: 'sk-testSecret123',
  });

  await assert.rejects(
    provider.complete({
      model: 'gpt-5',
      messages: [{ role: 'user', content: 'Hi' }],
      schema: z.object({ answer: z.string() }),
    }),
    (error: unknown) =>
      error instanceof ProviderErrorObject &&
      error.data.code === 'invalid_structured_output',
  );
});

test('sends OpenAI API key auth as bearer token', async () => {
  const transport = fakeTransport({
    responses: [
      response({ status: 'completed', output_text: 'ok', output: [] }),
    ],
  });

  const provider = createOpenAiProvider({
    transport,
    apiKey: 'sk-testSecret123',
  });

  await provider.complete({
    model: 'gpt-5',
    messages: [{ role: 'user', content: 'Hi' }],
  });

  assert.equal(
    transport.requests[0]?.headers?.authorization,
    'Bearer sk-testSecret123',
  );
});

test('sends exact OpenAI authorization header when supplied', async () => {
  const transport = fakeTransport({
    responses: [
      response({ status: 'completed', output_text: 'ok', output: [] }),
    ],
  });

  const provider = createOpenAiProvider({
    transport,
    authorization: 'Custom credential-value',
  });

  await provider.complete({
    model: 'gpt-5',
    messages: [{ role: 'user', content: 'Hi' }],
  });

  assert.equal(
    transport.requests[0]?.headers?.authorization,
    'Custom credential-value',
  );
});

test('omits OpenAI authorization header when credentials are omitted', async () => {
  const transport = fakeTransport({
    responses: [
      response({ status: 'completed', output_text: 'ok', output: [] }),
    ],
  });
  const provider = createOpenAiProvider({ transport });

  await provider.complete({
    model: 'gpt-5',
    messages: [{ role: 'user', content: 'Hi' }],
  });

  assert.equal(
    'authorization' in (transport.requests[0]?.headers ?? {}),
    false,
  );
});

test('omits OpenAI authorization header when credentials are blank', async () => {
  const transport = fakeTransport({
    responses: [
      response({ status: 'completed', output_text: 'ok', output: [] }),
    ],
  });

  const provider = createOpenAiProvider({
    transport,
    apiKey: '  ',
    authorization: '\t',
  });

  await provider.complete({
    model: 'gpt-5',
    messages: [{ role: 'user', content: 'Hi' }],
  });

  assert.equal(
    'authorization' in (transport.requests[0]?.headers ?? {}),
    false,
  );
});

test('rejects ambiguous OpenAI auth configuration', async () => {
  const provider = createOpenAiProvider({
    transport: fakeTransport({}),
    apiKey: 'sk-testSecret123',
    authorization: 'Bearer token',
  });

  await assert.rejects(
    provider.complete({
      model: 'gpt-5',
      messages: [{ role: 'user', content: 'Hi' }],
    }),
    (error: unknown) =>
      error instanceof ProviderErrorObject &&
      error.data.code === 'auth_ambiguous',
  );
});

test('rejects schema-invalid OpenAI structured JSON', async () => {
  const provider = createOpenAiProvider({
    transport: fakeTransport({
      responses: [
        response({
          status: 'completed',
          output_text: '{"answer":123}',
          output: [],
        }),
      ],
    }),
    apiKey: 'sk-testSecret123',
  });

  await assert.rejects(
    provider.complete({
      model: 'gpt-5',
      messages: [{ role: 'user', content: 'Hi' }],
      schema: z.object({ answer: z.string() }),
    }),
    (error: unknown) =>
      error instanceof ProviderErrorObject &&
      error.data.code === 'invalid_structured_output' &&
      error.data.diagnostic?.includes('answer') === true,
  );
});

test('does not refresh OpenAI auth after 401 responses', async () => {
  const transport = fakeTransport({
    responses: [response({ error: 'expired' }, 401)],
  });

  const provider = createOpenAiProvider({
    transport,
    authorization: 'Bearer expired-token',
  });

  await assert.rejects(
    provider.complete({
      model: 'gpt-5',
      messages: [{ role: 'user', content: 'Hi' }],
    }),
    (error: unknown) =>
      error instanceof ProviderErrorObject && error.data.code === 'auth_failed',
  );

  assert.equal(transport.requests.length, 1);
});
