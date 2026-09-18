import assert from 'node:assert/strict';
import test from 'node:test';

import { z } from 'zod';

import { ProviderErrorObject, openRouterBody } from '../src/index.js';
import { createOpenRouterProvider, fakeTransport, response } from './fakes.js';

test('maps OpenRouter chat completions DTO with messages tools and reasoning', () => {
  const body = openRouterBody(
    {
      model: 'openai/gpt-5',
      messages: [
        { role: 'system', content: 'System' },
        {
          role: 'assistant',
          content: 'Use tool',
          replay: [{ type: 'reasoning.encrypted', data: 'opaque' }],
          toolCalls: [
            { id: 'call_1', name: 'lookup', arguments: '{}', index: 0 },
          ],
        },
        { role: 'tool', toolCallId: 'call_1', content: 'Result' },
      ],
      tools: [
        {
          name: 'lookup',
          inputSchema: {
            type: 'object',
            properties: {},
            required: [],
            additionalProperties: false,
          },
          outputSchema: {},
          strict: true,
        },
      ],
      toolChoice: { name: 'lookup' },
      parallelToolCalls: false,
      temperature: 0.1,
      maxOutputTokens: 32,
      flags: { reasoning: { effort: 'medium' } },
    },
    false,
  );

  assert.equal(body.model, 'openai/gpt-5');
  assert.equal(body.stream, false);
  assert.equal(body.max_tokens, 32);
  assert.deepEqual(body.reasoning, { effort: 'medium' });
  assert.deepEqual(body.tool_choice, {
    type: 'function',
    function: { name: 'lookup' },
  });
  assert.equal(body.parallel_tool_calls, false);
  assert.deepEqual(body.tools, [
    {
      type: 'function',
      function: {
        name: 'lookup',
        parameters: {
          type: 'object',
          properties: {},
          required: [],
          additionalProperties: false,
        },
        strict: true,
      },
    },
  ]);
  assert.deepEqual(body.messages, [
    { role: 'system', content: 'System' },
    {
      role: 'assistant',
      content: 'Use tool',
      reasoning_details: [{ type: 'reasoning.encrypted', data: 'opaque' }],
      tool_calls: [
        {
          id: 'call_1',
          type: 'function',
          function: { name: 'lookup', arguments: '{}' },
        },
      ],
    },
    { role: 'tool', content: 'Result', tool_call_id: 'call_1' },
  ]);
  assert.equal('response_format' in body, false);
});

test('supports conservative OpenRouter structured-output fallbacks', () => {
  const request = {
    model: 'mistralai/mistral-small',
    messages: [{ role: 'user' as const, content: 'Return JSON.' }],
    schema: z.object({ answer: z.string() }),
  };

  const jsonObject = openRouterBody(request, false, {
    structuredOutput: 'json_object',
    requireParameters: true,
  });
  const promptOnly = openRouterBody(request, false, {
    structuredOutput: 'prompt',
  });

  assert.deepEqual(jsonObject.response_format, { type: 'json_object' });
  assert.deepEqual(jsonObject.provider, { require_parameters: true });
  assert.equal(
    (jsonObject.messages as readonly { readonly role: string }[])[0]?.role,
    'system',
  );
  assert.equal('response_format' in promptOnly, false);
  assert.equal(
    (promptOnly.messages as readonly { readonly role: string }[])[0]?.role,
    'system',
  );
});

test('maps top-level OpenRouter effort before legacy reasoning effort', () => {
  const body = openRouterBody(
    {
      model: 'openai/gpt-5',
      messages: [{ role: 'user', content: 'Plan it.' }],
      effort: 'none',
      flags: { reasoning: { effort: 'medium', summary: 'detailed' } },
    },
    false,
  );

  assert.deepEqual(body.reasoning, { effort: 'none', summary: 'detailed' });
});

test('maps OpenRouter structured output schemas to response format DTOs', () => {
  const body = openRouterBody(
    {
      model: 'openai/gpt-5',
      messages: [{ role: 'user', content: 'Return JSON.' }],
      schema: z.object({ answer: z.string() }),
    },
    false,
  );

  assert.deepEqual(body.response_format, {
    type: 'json_schema',
    json_schema: {
      name: 'structured_output',
      strict: true,
      schema: {
        $schema: 'https://json-schema.org/draft/2020-12/schema',
        type: 'object',
        properties: { answer: { type: 'string' } },
        required: ['answer'],
        additionalProperties: false,
      },
    },
  });
});

test('adds a schema system instruction while retaining OpenRouter response format', () => {
  const messages = [
    { role: 'system' as const, content: 'Follow policy.' },
    { role: 'user' as const, content: 'Return JSON.' },
  ];
  const request = {
    model: 'openai/gpt-5',
    messages,
    schema: z.object({ answer: z.string() }),
    flags: { includeStructuredSchemaOnSystemPrompt: true },
  } as const;

  const body = openRouterBody(request, false);
  const bodyMessages = body.messages as readonly {
    readonly role: string;
    readonly content: string;
  }[];

  assert.deepEqual(
    bodyMessages.map(({ role }) => role),
    ['system', 'system', 'user'],
  );
  assert.equal(bodyMessages[0]?.content, 'Follow policy.');
  assert.match(
    bodyMessages[1]?.content ?? '',
    /Return exactly one JSON object[\s\S]*JSON Schema/u,
  );
  assert.equal(bodyMessages[2]?.content, 'Return JSON.');
  assert.equal(
    (body.response_format as { readonly type?: string }).type,
    'json_schema',
  );
  assert.equal(request.messages, messages);
  assert.deepEqual(request.messages, messages);
});

test('maps OpenRouter nested union structured output schemas to response format DTOs', () => {
  const body = openRouterBody(
    {
      model: 'openai/gpt-5',
      messages: [{ role: 'user', content: 'Return JSON.' }],
      schema: z
        .object({
          action: z.union([
            z.object({ type: z.literal('question'), question: z.string() }),
            z.object({ type: z.literal('answer'), answer: z.string() }),
          ]),
        })
        .strict(),
    },
    false,
  );
  const responseFormat = body.response_format as {
    readonly json_schema?: {
      readonly schema?: {
        readonly type?: unknown;
        readonly properties?: {
          readonly action?: {
            readonly anyOf?: unknown;
          };
        };
      };
    };
  };
  const variants =
    responseFormat.json_schema?.schema?.properties?.action?.anyOf;

  assert.equal(responseFormat.json_schema?.schema?.type, 'object');
  assert.ok(Array.isArray(variants));
  assert.equal(variants.length, 2);
  assert.deepEqual(
    variants.map((variant) => (variant as Record<string, unknown>).type),
    ['object', 'object'],
  );
});

test('rejects OpenRouter top-level union structured output schemas', () => {
  const request = {
    model: 'openai/gpt-5',
    messages: [{ role: 'user', content: 'Return JSON.' }],
  } as const;

  assert.throws(
    () =>
      openRouterBody(
        {
          ...request,
          schema: z.union([
            z.object({ type: z.literal('question'), question: z.string() }),
            z.object({ type: z.literal('answer'), answer: z.string() }),
          ]),
        },
        false,
      ),
    (error: unknown) =>
      error instanceof ProviderErrorObject &&
      error.data.code === 'invalid_structured_schema',
  );
});

test('parses OpenRouter completion and redacts auth failures', async () => {
  const transport = fakeTransport({
    responses: [
      response({
        choices: [
          {
            finish_reason: 'tool_calls',
            message: {
              content: 'Hello',
              reasoning: 'Because',
              reasoning_details: [
                { type: 'reasoning.encrypted', data: 'opaque' },
              ],
              refusal: 'No',
              tool_calls: [
                {
                  id: 'call_1',
                  function: { name: 'lookup', arguments: '{"q":"x"}' },
                },
              ],
            },
          },
        ],
        usage: {
          prompt_tokens: 2,
          completion_tokens: 3,
          total_tokens: 5,
          cost: 0.000_01,
          cost_details: { upstream_inference_cost: 0.000_008 },
          completion_tokens_details: { reasoning_tokens: 1 },
          prompt_tokens_details: {
            cached_tokens: 1,
            cache_write_tokens: 2,
          },
        },
      }),
      response({ error: { message: 'bad sk-testSecret123' } }, 401),
      response({ error: { message: 'forbidden sk-testSecret456' } }, 403),
    ],
  });
  const provider = createOpenRouterProvider({
    transport,
    apiKey: 'sk-testSecret123',
  });

  const result = await provider.complete({
    model: 'openai/gpt-5',
    messages: [{ role: 'user', content: 'Hi' }],
  });

  assert.equal(result.text, 'Hello');
  assert.equal(result.finishReason, 'tool_calls');
  assert.deepEqual(result.reasoning, { text: 'Because' });
  assert.deepEqual(result.replay, [
    { type: 'reasoning.encrypted', data: 'opaque' },
  ]);
  assert.equal(result.refusal, 'No');
  assert.deepEqual(result.toolCalls, [
    { id: 'call_1', name: 'lookup', arguments: '{"q":"x"}', index: 0 },
  ]);
  assert.deepEqual(result.usage, {
    inputTokens: 2,
    outputTokens: 3,
    totalTokens: 5,
    reasoningTokens: 1,
    cachedInputTokens: 1,
    cacheWriteTokens: 2,
    cost: {
      amount: 0.000_01,
      unit: 'credits',
      upstreamAmount: 0.000_008,
    },
  });

  await assert.rejects(
    provider.complete({
      model: 'openai/gpt-5',
      messages: [{ role: 'user', content: 'Hi' }],
    }),
    (error: unknown) =>
      error instanceof ProviderErrorObject &&
      error.data.code === 'auth_failed' &&
      error.data.diagnostic?.includes('sk-[redacted]') === true,
  );

  await assert.rejects(
    provider.complete({
      model: 'openai/gpt-5',
      messages: [{ role: 'user', content: 'Hi' }],
    }),
    (error: unknown) =>
      error instanceof ProviderErrorObject &&
      error.data.code === 'auth_failed' &&
      error.data.status === 403 &&
      error.data.diagnostic?.includes('sk-[redacted]') === true,
  );
});

test('returns parsed OpenRouter structured output from completions', async () => {
  const transport = fakeTransport({
    responses: [
      response({
        choices: [
          {
            finish_reason: 'stop',
            message: { content: '{"answer":"Done"}' },
          },
        ],
      }),
    ],
  });
  const provider = createOpenRouterProvider({ transport, apiKey: 'key' });

  const result = await provider.complete({
    model: 'openai/gpt-5',
    messages: [{ role: 'user', content: 'Hi' }],
    schema: z.object({ answer: z.string() }),
  });

  assert.deepEqual(result.structured, { answer: 'Done' });
});

test('rejects OpenRouter requests that are missing model or input', async () => {
  const provider = createOpenRouterProvider({
    transport: fakeTransport({}),
    apiKey: 'key',
  });

  await assert.rejects(
    provider.complete({
      model: '',
      messages: [{ role: 'user', content: 'Hi' }],
    }),
    (error: unknown) =>
      error instanceof ProviderErrorObject &&
      error.data.code === 'missing_model',
  );

  await assert.rejects(
    provider.complete({ model: 'openai/gpt-5', messages: [] }),
    (error: unknown) =>
      error instanceof ProviderErrorObject &&
      error.data.code === 'missing_input',
  );
});

test('fetches and validates OpenRouter models with context fallback', async () => {
  const provider = createOpenRouterProvider({
    transport: fakeTransport({
      responses: [
        response({
          data: [
            { id: 'a', name: 'A', context_length: 8192 },
            { id: 'b', top_provider: { context_length: 4096 } },
            { id: 'c' },
          ],
        }),
        response({
          data: [{ id: 'b', top_provider: { context_length: 4096 } }],
        }),
      ],
    }),
    apiKey: 'key',
  });

  const models = await provider.models();
  assert.deepEqual(
    models.map((model) => [model.id, model.contextWindow]),
    [
      ['a', 8192],
      ['b', 4096],
      ['c', 4096],
    ],
  );
  assert.equal((await provider.validateModel('b')).contextWindow, 4096);
});

test('rejects schema-invalid OpenRouter structured JSON', async () => {
  const provider = createOpenRouterProvider({
    transport: fakeTransport({
      responses: [
        response({
          choices: [
            {
              finish_reason: 'stop',
              message: { content: '{"answer":123}' },
            },
          ],
        }),
      ],
    }),
    apiKey: 'key',
  });

  await assert.rejects(
    provider.complete({
      model: 'openai/gpt-5',
      messages: [{ role: 'user', content: 'Hi' }],
      schema: z.object({ answer: z.string() }),
    }),
    (error: unknown) =>
      error instanceof ProviderErrorObject &&
      error.data.code === 'invalid_structured_output' &&
      error.data.diagnostic?.includes('answer') === true,
  );
});

test('describes an empty structured response without exposing response data', async () => {
  const provider = createOpenRouterProvider({
    transport: fakeTransport({
      responses: [
        response({
          choices: [
            {
              finish_reason: 'length',
              message: { content: '' },
            },
          ],
          usage: {
            completion_tokens: 128,
            completion_tokens_details: { reasoning_tokens: 128 },
          },
        }),
      ],
    }),
    apiKey: 'key',
  });

  await assert.rejects(
    provider.complete({
      model: 'qwen/qwen3.7-flash',
      messages: [{ role: 'user', content: 'Hi' }],
      schema: z.object({ answer: z.string() }),
    }),
    (error: unknown) =>
      error instanceof ProviderErrorObject &&
      error.data.code === 'invalid_structured_output' &&
      error.data.diagnostic?.includes('response text was empty') === true &&
      error.data.diagnostic.includes('finishReason=length') &&
      error.data.diagnostic.includes('outputTokens=128') &&
      error.data.diagnostic.includes('reasoningTokens=128'),
  );
});

test('rejects blank OpenRouter API keys', async () => {
  const provider = createOpenRouterProvider({
    transport: fakeTransport({}),
    apiKey: ' ',
  });

  await assert.rejects(
    provider.complete({
      model: 'openai/gpt-5',
      messages: [{ role: 'user', content: 'Hi' }],
    }),
    (error: unknown) =>
      error instanceof ProviderErrorObject &&
      error.data.code === 'auth_missing',
  );
});
