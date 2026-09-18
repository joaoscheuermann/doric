import assert from 'node:assert/strict';
import test from 'node:test';

import { z } from 'zod';

import { ProviderErrorObject, type ProviderStreamEvent } from '../src/index.js';
import {
  collect,
  createLmStudioOpenAiProvider,
  fakeTransport,
  response,
} from './fakes.js';

const answerJsonSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  properties: { answer: { type: 'string' } },
  required: ['answer'],
  additionalProperties: false,
} as const;

const lookupInputSchema = {
  type: 'object',
  properties: { query: { type: 'string' } },
  required: ['query'],
  additionalProperties: false,
} as const;

test('sends LM Studio OpenAI-compatible structured output requests without tools through response format', async () => {
  const transport = fakeTransport({
    responses: [
      response({
        choices: [
          {
            finish_reason: 'stop',
            message: { content: '{"answer":"Done"}' },
          },
        ],
        usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 },
      }),
    ],
  });
  const provider = createLmStudioOpenAiProvider({ transport });

  const result = await provider.complete({
    model: 'local-model',
    messages: [
      { role: 'system', content: 'Follow policy.' },
      { role: 'user', content: 'Return JSON.' },
    ],
    schema: z.object({ answer: z.string() }),
    temperature: 0.2,
    maxOutputTokens: 64,
  });
  const body = JSON.parse(transport.requests[0]?.body ?? '{}');

  assert.equal(provider.metadata.id, 'lmstudio-openai');

  assert.equal(provider.metadata.name, 'LM Studio OpenAI Compatibility');

  assert.equal(provider.metadata.baseUrl, 'http://localhost:1234/v1');

  assert.equal(provider.capabilities.tools, true);

  assert.equal(provider.capabilities.structuredOutputs, true);

  assert.equal(
    transport.requests[0]?.url,
    'http://localhost:1234/v1/chat/completions',
  );

  assert.equal(
    'authorization' in (transport.requests[0]?.headers ?? {}),
    false,
  );

  assert.deepEqual(body, {
    model: 'local-model',
    messages: [
      { role: 'system', content: 'Follow policy.' },
      { role: 'user', content: 'Return JSON.' },
    ],
    temperature: 0.2,
    max_tokens: 64,
    response_format: {
      type: 'json_schema',
      json_schema: {
        name: 'structured_output',
        strict: true,
        schema: answerJsonSchema,
      },
    },
    stream: false,
  });

  assert.equal(result.text, '{"answer":"Done"}');

  assert.deepEqual(result.structured, { answer: 'Done' });

  assert.deepEqual(result.usage, {
    inputTokens: 2,
    outputTokens: 3,
    totalTokens: 5,
    reasoningTokens: undefined,
    cachedInputTokens: undefined,
  });
});

test('adds a schema system instruction while retaining LM Studio response format', async () => {
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
  const provider = createLmStudioOpenAiProvider({ transport });

  await provider.complete({
    model: 'local-model',
    messages: [
      { role: 'system', content: 'First policy.' },
      { role: 'system', content: 'Second policy.' },
      { role: 'user', content: 'Return JSON.' },
    ],
    schema: z.object({ answer: z.string() }),
    flags: { includeStructuredSchemaOnSystemPrompt: true },
  });

  const body = JSON.parse(transport.requests[0]?.body ?? '{}');

  assert.deepEqual(
    body.messages.map((message: { readonly role: string }) => message.role),
    ['system', 'system', 'system', 'user'],
  );

  assert.equal(body.messages[0].content, 'First policy.');

  assert.equal(body.messages[1].content, 'Second policy.');

  assert.match(
    body.messages[2].content,
    /Return exactly one JSON object[\s\S]*JSON Schema/u,
  );

  assert.equal(body.messages[3].content, 'Return JSON.');

  assert.equal(body.response_format.type, 'json_schema');
});

test('sends LM Studio OpenAI-compatible reasoning effort as top-level chat field', async () => {
  const transport = fakeTransport({
    responses: [response({ choices: [{ message: { content: 'ok' } }] })],
  });
  const provider = createLmStudioOpenAiProvider({ transport });

  await provider.complete({
    model: 'local-model',
    messages: [{ role: 'user', content: 'Hi' }],
    effort: 'minimal',
    flags: { reasoning: { effort: 'high' } },
  });

  const body = JSON.parse(transport.requests[0]?.body ?? '{}');

  assert.equal(body.reasoning_effort, 'minimal');
});

test('rejects LM Studio OpenAI-compatible structured requests with tools before sending HTTP', async () => {
  const transport = fakeTransport({});
  const provider = createLmStudioOpenAiProvider({ transport });

  await assert.rejects(
    provider.complete({
      model: 'local-model',
      messages: [{ role: 'user', content: 'Return JSON.' }],
      tools: [
        {
          name: 'lookup',
          inputSchema: lookupInputSchema,
          outputSchema: {},
        },
      ],
      schema: z.object({ answer: z.string() }),
    }),
    (error: unknown) =>
      error instanceof ProviderErrorObject &&
      error.data.provider === 'lmstudio-openai' &&
      error.data.code === 'unsupported_structured_tools' &&
      error.data.message.includes('combine tools with structured output'),
  );

  assert.equal(transport.requests.length, 0);
});

test('sends LM Studio OpenAI-compatible tool requests without structured output', async () => {
  const transport = fakeTransport({
    responses: [
      response({
        choices: [
          {
            finish_reason: 'tool_calls',
            message: {
              tool_calls: [
                {
                  id: 'call_lookup',
                  function: {
                    name: 'lookup',
                    arguments: '{"query":"item"}',
                  },
                },
              ],
            },
          },
        ],
      }),
    ],
  });
  const provider = createLmStudioOpenAiProvider({ transport });

  const result = await provider.complete({
    model: 'local-model',
    messages: [{ role: 'user', content: 'Use a tool.' }],
    tools: [
      {
        name: 'lookup',
        description: 'Find an item.',
        inputSchema: lookupInputSchema,
        outputSchema: {},
      },
    ],
  });
  const body = JSON.parse(transport.requests[0]?.body ?? '{}');

  assert.equal('response_format' in body, false);

  assert.deepEqual(body.tools, [
    {
      type: 'function',
      function: {
        name: 'lookup',
        description: 'Find an item.',
        parameters: lookupInputSchema,
      },
    },
  ]);

  assert.deepEqual(result.toolCalls, [
    {
      id: 'call_lookup',
      name: 'lookup',
      arguments: '{"query":"item"}',
      index: 0,
    },
  ]);
});

test('lists LM Studio OpenAI-compatible models with custom base URL and API key auth', async () => {
  const transport = fakeTransport({
    responses: [
      response({
        data: [
          { id: 'local-model', object: 'model' },
          { id: '', object: 'model' },
        ],
      }),
      response({ data: [{ id: 'local-model', object: 'model' }] }),
    ],
  });

  const provider = createLmStudioOpenAiProvider({
    transport,
    baseUrl: 'http://127.0.0.1:4321/v1',
    apiKey: 'local-key',
  });
  const models = await provider.models();

  assert.equal(transport.requests[0]?.url, 'http://127.0.0.1:4321/v1/models');

  assert.equal(
    transport.requests[0]?.headers?.authorization,
    'Bearer local-key',
  );

  assert.deepEqual(models, [
    {
      id: 'local-model',
      name: 'local-model',
      provider: 'lmstudio-openai',
      raw: { id: 'local-model', object: 'model' },
    },
  ]);

  assert.equal((await provider.validateModel('local-model')).id, 'local-model');
});

test('maps LM Studio OpenAI-compatible authorization modes', async () => {
  const blank = fakeTransport({
    responses: [response({ choices: [{ message: { content: 'ok' } }] })],
  });

  const exact = fakeTransport({
    responses: [response({ choices: [{ message: { content: 'ok' } }] })],
  });

  await createLmStudioOpenAiProvider({
    transport: blank,
    apiKey: ' ',
    authorization: '\t',
  }).complete({
    model: 'local-model',
    messages: [{ role: 'user', content: 'Hi' }],
  });

  await createLmStudioOpenAiProvider({
    transport: exact,
    authorization: 'Bearer session-token',
  }).complete({
    model: 'local-model',
    messages: [{ role: 'user', content: 'Hi' }],
  });

  assert.equal('authorization' in (blank.requests[0]?.headers ?? {}), false);

  assert.equal(
    exact.requests[0]?.headers?.authorization,
    'Bearer session-token',
  );

  await assert.rejects(
    createLmStudioOpenAiProvider({
      transport: fakeTransport({}),
      apiKey: 'local-key',
      authorization: 'Bearer session-token',
    }).complete({
      model: 'local-model',
      messages: [{ role: 'user', content: 'Hi' }],
    }),
    (error: unknown) =>
      error instanceof ProviderErrorObject &&
      error.data.provider === 'lmstudio-openai' &&
      error.data.code === 'auth_ambiguous',
  );
});

test('streams LM Studio OpenAI-compatible chat completion events', async () => {
  const provider = createLmStudioOpenAiProvider({
    transport: fakeTransport({
      streams: [
        [
          sse({ choices: [{ delta: { content: 'Hel' } }] }),
          sse({ choices: [{ delta: { content: 'lo' } }] }),
          sse({
            choices: [
              {
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: 'call_1',
                      function: { name: 'lookup', arguments: '{"q":"x"}' },
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
  });

  const events = await collect(
    provider.stream({
      model: 'local-model',
      messages: [{ role: 'user', content: 'Hi' }],
    }),
  );
  const finished = events.at(-1);

  assert.deepEqual(events[0], {
    type: 'response.started',
    provider: 'lmstudio-openai',
    model: 'local-model',
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

  assert.ok(events.some((event) => event.type === 'usage'));

  assert.deepEqual(
    events
      .filter(
        (event): event is ProviderStreamEvent & { type: 'tool_call.done' } =>
          event.type === 'tool_call.done',
      )
      .map((event) => event.call),
    [{ id: 'call_1', name: 'lookup', arguments: '{"q":"x"}', index: 0 }],
  );

  assert.equal(finished?.type, 'response.finished');

  if (finished?.type !== 'response.finished') {
    assert.fail('Expected final response.finished event.');
  }

  assert.equal(finished.finish.text, 'Hello');

  assert.equal(finished.finish.finishReason, 'tool_calls');

  assert.deepEqual(finished.finish.usage, {
    inputTokens: 1,
    outputTokens: 2,
    totalTokens: 3,
    reasoningTokens: undefined,
    cachedInputTokens: undefined,
  });
});

test('rejects LM Studio OpenAI-compatible structured streams with tools before starting transport', async () => {
  const transport = fakeTransport({});
  const provider = createLmStudioOpenAiProvider({ transport });

  const stream = provider.stream({
    model: 'local-model',
    messages: [{ role: 'user', content: 'Hi' }],
    tools: [
      { name: 'lookup', inputSchema: { type: 'object' }, outputSchema: {} },
    ],
    schema: z.object({ answer: z.string() }),
  });

  await assert.rejects(
    stream[Symbol.asyncIterator]().next(),
    (error: unknown) =>
      error instanceof ProviderErrorObject &&
      error.data.provider === 'lmstudio-openai' &&
      error.data.code === 'unsupported_structured_tools' &&
      error.data.message.includes('combine tools with structured output'),
  );

  assert.equal(transport.requests.length, 0);
});

const sse = (value: unknown): string => `data: ${JSON.stringify(value)}\n\n`;
