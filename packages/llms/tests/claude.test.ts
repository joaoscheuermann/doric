import assert from 'node:assert/strict';
import test from 'node:test';

import { z } from 'zod';

import {
  claudeUserAgent,
  createClaudeProvider,
  ProviderErrorObject,
} from '../src/index.js';
import {
  type FakeTransport,
  fakeTransport,
  response,
  silentLogger,
} from './fakes.js';

interface RequestBody extends Record<string, unknown> {
  system?: string;
  messages?: unknown[];
  tools?: readonly {
    readonly name: string;
    readonly description: string;
    readonly input_schema: unknown;
  }[];
  tool_choice?: unknown;
  max_tokens?: number;
  temperature?: number;
  stream?: boolean;
}

/** A finished Anthropic Messages response with the given content blocks. */
const messageResponse = (
  content: readonly unknown[],
  extra: Record<string, unknown> = {},
): Record<string, unknown> => ({
  id: 'msg_1',
  type: 'message',
  role: 'assistant',
  content,
  model: 'claude-sonnet-4-5',
  stop_reason: 'end_turn',
  usage: { input_tokens: 3, output_tokens: 4 },
  ...extra,
});

const bodyOf = (transport: FakeTransport, index = 0): RequestBody =>
  JSON.parse(transport.requests[index]?.body ?? '{}') as RequestBody;

void test('sends Anthropic Messages requests with the Claude Code OAuth headers', async () => {
  const transport = fakeTransport({
    responses: [response(messageResponse([{ type: 'text', text: 'ok' }]))],
  });

  const provider = createClaudeProvider({
    transport,
    authorization: 'Bearer claude-token',
    logger: silentLogger,
  });

  const result = await provider.complete({
    model: 'claude-sonnet-4-5',
    messages: [{ role: 'user', content: 'Hi' }],
  });

  assert.equal(provider.metadata.id, 'claude');

  assert.deepEqual(provider.metadata, {
    id: 'claude',
    name: 'Claude',
    baseUrl: 'https://api.anthropic.com',
  });

  assert.deepEqual(provider.capabilities, {
    streaming: true,
    embeddings: false,
    reranking: false,
    tools: true,
    reasoning: false,
    modelListing: true,
    oauth: true,
    serviceTier: false,
    structuredOutputs: false,
  });

  assert.equal(claudeUserAgent, 'claude-cli/2.1.309 (external, cli)');

  assert.equal(
    transport.requests[0]?.url,
    'https://api.anthropic.com/v1/messages?beta=true',
  );

  assert.deepEqual(transport.requests[0]?.headers, {
    authorization: 'Bearer claude-token',
    'anthropic-version': '2023-06-01',
    'anthropic-beta': 'oauth-2025-04-20,claude-code-20250219',
    'x-app': 'cli',
    'user-agent': 'claude-cli/2.1.309 (external, cli)',
    'content-type': 'application/json',
    accept: 'application/json',
  });

  assert.equal(result.text, 'ok');
});

void test('answers a completion with mapped text, finish reason, and usage', async () => {
  const transport = fakeTransport({
    responses: [
      response({
        id: 'msg_1',
        type: 'message',
        role: 'assistant',
        content: [
          { type: 'text', text: 'Hel' },
          { type: 'text', text: 'lo' },
          {
            type: 'tool_use',
            id: 'toolu_1',
            name: 'lookup',
            input: { query: 'x' },
          },
        ],
        model: 'claude-sonnet-4-5',
        stop_reason: 'end_turn',
        usage: {
          input_tokens: 3,
          output_tokens: 4,
          cache_creation_input_tokens: 5,
          cache_read_input_tokens: 6,
        },
      }),
    ],
  });

  const provider = createClaudeProvider({
    transport,
    authorization: 'Bearer claude-token',
    logger: silentLogger,
  });

  const result = await provider.complete({
    model: 'claude-sonnet-4-5',
    messages: [{ role: 'user', content: 'Hi' }],
  });

  assert.equal(result.text, 'Hello');

  assert.equal(result.finishReason, 'stop');

  assert.deepEqual(result.toolCalls, [
    { id: 'toolu_1', name: 'lookup', arguments: '{"query":"x"}', index: 0 },
  ]);

  assert.deepEqual(result.usage, {
    inputTokens: 3,
    outputTokens: 4,
    cacheWriteTokens: 5,
    cachedInputTokens: 6,
    totalTokens: 18,
  });
});

void test('sends the default Claude Code instructions when no system message is present', async () => {
  const transport = fakeTransport({
    responses: [response(messageResponse([{ type: 'text', text: 'ok' }]))],
  });

  const provider = createClaudeProvider({
    transport,
    authorization: 'Bearer claude-token',
    logger: silentLogger,
  });

  await provider.complete({
    model: 'claude-sonnet-4-5',
    messages: [{ role: 'user', content: 'Hi' }],
  });

  assert.equal(
    bodyOf(transport).system,
    "You are Claude Code, Anthropic's official CLI for Claude.",
  );
});

void test('keeps authored system messages in the system field', async () => {
  const transport = fakeTransport({
    responses: [response(messageResponse([{ type: 'text', text: 'ok' }]))],
  });

  const provider = createClaudeProvider({
    transport,
    authorization: 'Bearer claude-token',
    logger: silentLogger,
  });

  await provider.complete({
    model: 'claude-sonnet-4-5',
    messages: [
      { role: 'system', content: 'First policy.' },
      { role: 'system', content: 'Second policy.' },
      { role: 'user', content: 'Hi' },
    ],
  });

  assert.equal(bodyOf(transport).system, 'First policy.\n\nSecond policy.');
});

void test('maps tool definitions, tool choice, and assistant tool calls', async () => {
  const inputSchema = {
    type: 'object',
    properties: { query: { type: 'string' } },
  };

  const transport = fakeTransport({
    responses: [
      response(messageResponse([{ type: 'text', text: 'ok' }])),
      response(messageResponse([{ type: 'text', text: 'ok' }])),
      response(messageResponse([{ type: 'text', text: 'ok' }])),
    ],
  });

  const provider = createClaudeProvider({
    transport,
    authorization: 'Bearer claude-token',
    logger: silentLogger,
  });

  const tools = [
    {
      name: 'lookup',
      description: 'Search docs',
      inputSchema,
      outputSchema: { type: 'string' },
      strict: true,
    },
  ];

  await provider.complete({
    model: 'claude-sonnet-4-5',
    messages: [{ role: 'user', content: 'Find it.' }],
    tools,
    toolChoice: 'required',
  });

  await provider.complete({
    model: 'claude-sonnet-4-5',
    messages: [{ role: 'user', content: 'Find it.' }],
    tools,
    toolChoice: { name: 'lookup' },
  });

  await provider.complete({
    model: 'claude-sonnet-4-5',
    messages: [
      { role: 'user', content: 'Find it.' },
      {
        role: 'assistant',
        content: '',
        toolCalls: [
          { id: 'toolu_1', name: 'lookup', arguments: '{"query":"x"}' },
          { id: 'toolu_2', name: 'probe', arguments: '' },
        ],
      },
    ],
  });

  assert.deepEqual(bodyOf(transport, 0).tools, [
    {
      name: 'lookup',
      description: 'Search docs',
      input_schema: inputSchema,
    },
  ]);

  assert.equal(bodyOf(transport, 0).tool_choice, 'any');

  assert.deepEqual(bodyOf(transport, 1).tool_choice, {
    type: 'tool',
    name: 'lookup',
  });

  assert.deepEqual(bodyOf(transport, 2).messages, [
    { role: 'user', content: [{ type: 'text', text: 'Find it.' }] },
    {
      role: 'assistant',
      content: [
        {
          type: 'tool_use',
          id: 'toolu_1',
          name: 'lookup',
          input: { query: 'x' },
        },
        { type: 'tool_use', id: 'toolu_2', name: 'probe', input: {} },
      ],
    },
  ]);
});

void test('maps tool results as user tool_result blocks', async () => {
  const transport = fakeTransport({
    responses: [response(messageResponse([{ type: 'text', text: 'ok' }]))],
  });

  const provider = createClaudeProvider({
    transport,
    authorization: 'Bearer claude-token',
    logger: silentLogger,
  });

  await provider.complete({
    model: 'claude-sonnet-4-5',
    messages: [
      { role: 'user', content: 'Find it.' },
      {
        role: 'assistant',
        content: '',
        toolCalls: [
          { id: 'toolu_1', name: 'lookup', arguments: '{}' },
          { id: 'toolu_2', name: 'probe', arguments: '{}' },
        ],
      },
      { role: 'tool', toolCallId: 'toolu_1', content: 'tool output' },
      {
        role: 'tool',
        toolCallId: 'toolu_2',
        content: 'partial',
        toolResultStatus: 'incomplete',
      },
    ],
  });

  assert.deepEqual(bodyOf(transport).messages, [
    { role: 'user', content: [{ type: 'text', text: 'Find it.' }] },
    {
      role: 'assistant',
      content: [
        { type: 'tool_use', id: 'toolu_1', name: 'lookup', input: {} },
        { type: 'tool_use', id: 'toolu_2', name: 'probe', input: {} },
      ],
    },
    {
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 'toolu_1', content: 'tool output' },
        {
          type: 'tool_result',
          tool_use_id: 'toolu_2',
          content: 'partial',
          status: 'incomplete',
        },
      ],
    },
  ]);
});

void test('sends user images as Anthropic image source blocks', async () => {
  const transport = fakeTransport({
    responses: [response(messageResponse([{ type: 'text', text: 'ok' }]))],
  });

  const provider = createClaudeProvider({
    transport,
    authorization: 'Bearer claude-token',
    logger: silentLogger,
  });

  await provider.complete({
    model: 'claude-sonnet-4-5',
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Look at this.' },
          { type: 'image', imageUrl: 'data:image/png;base64,abc123' },
          { type: 'image', imageUrl: 'https://example.test/cat.png' },
        ],
      },
    ],
  });

  assert.deepEqual(bodyOf(transport).messages, [
    {
      role: 'user',
      content: [
        { type: 'text', text: 'Look at this.' },
        {
          type: 'image',
          source: { type: 'base64', media_type: 'image/png', data: 'abc123' },
        },
        {
          type: 'image',
          source: { type: 'url', url: 'https://example.test/cat.png' },
        },
      ],
    },
  ]);
});

void test('requires max_tokens and honors the caller limit', async () => {
  const transport = fakeTransport({
    responses: [
      response(messageResponse([{ type: 'text', text: 'ok' }])),
      response(messageResponse([{ type: 'text', text: 'ok' }])),
    ],
  });

  const provider = createClaudeProvider({
    transport,
    authorization: 'Bearer claude-token',
    logger: silentLogger,
  });

  await provider.complete({
    model: 'claude-sonnet-4-5',
    messages: [{ role: 'user', content: 'Hi' }],
  });

  await provider.complete({
    model: 'claude-sonnet-4-5',
    messages: [{ role: 'user', content: 'Hi' }],
    maxOutputTokens: 100,
  });

  assert.equal(bodyOf(transport, 0).max_tokens, 32000);

  assert.equal(bodyOf(transport, 1).max_tokens, 100);
});

void test('ignores the request effort rather than sending reasoning controls', async () => {
  const transport = fakeTransport({
    responses: [response(messageResponse([{ type: 'text', text: 'ok' }]))],
  });

  const provider = createClaudeProvider({
    transport,
    authorization: 'Bearer claude-token',
    logger: silentLogger,
  });

  await provider.complete({
    model: 'claude-sonnet-4-5',
    messages: [{ role: 'user', content: 'Hi' }],
    effort: 'high',
    flags: { reasoning: { effort: 'high' } },
  });

  const body = bodyOf(transport);

  assert.equal('thinking' in body, false);

  assert.equal('response_format' in body, false);

  assert.equal('parallel_tool_calls' in body, false);

  assert.equal('effort' in body, false);
});

void test('parses and validates a structured output from the response text', async () => {
  const transport = fakeTransport({
    responses: [
      response(messageResponse([{ type: 'text', text: '{"answer":"Done"}' }])),
    ],
  });

  const provider = createClaudeProvider({
    transport,
    authorization: 'Bearer claude-token',
    logger: silentLogger,
  });

  const result = await provider.complete({
    model: 'claude-sonnet-4-5',
    messages: [{ role: 'user', content: 'Hi' }],
    schema: z.object({ answer: z.string() }),
  });
  const answer: string = result.structured.answer;

  assert.deepEqual(result.structured, { answer: 'Done' });

  assert.equal(answer, 'Done');
});

void test('injects the schema into the system prompt when the flag is set', async () => {
  const transport = fakeTransport({
    responses: [
      response(messageResponse([{ type: 'text', text: '{"answer":"Done"}' }])),
    ],
  });

  const provider = createClaudeProvider({
    transport,
    authorization: 'Bearer claude-token',
    logger: silentLogger,
  });

  await provider.complete({
    model: 'claude-sonnet-4-5',
    messages: [
      { role: 'system', content: 'Follow policy.' },
      { role: 'user', content: 'Return JSON.' },
    ],
    schema: z.object({ answer: z.string() }),
    flags: { includeStructuredSchemaOnSystemPrompt: true },
  });

  const body = bodyOf(transport);

  assert.match(
    body.system as string,
    /^Follow policy\.[\s\S]*Return exactly one JSON object[\s\S]*JSON Schema/u,
  );

  assert.deepEqual(body.messages, [
    { role: 'user', content: [{ type: 'text', text: 'Return JSON.' }] },
  ]);
});

void test('lists models from the Anthropic models endpoint and validates a named model', async () => {
  const modelsAnswer = () =>
    response({
      data: [
        { id: 'claude-sonnet-4-5-20250929', display_name: 'Sonnet 4.5' },
        { id: '', display_name: 'Empty' },
      ],
    });

  const transport = fakeTransport({
    responses: [modelsAnswer(), modelsAnswer(), modelsAnswer()],
  });

  const provider = createClaudeProvider({
    transport,
    authorization: 'Bearer claude-token',
    logger: silentLogger,
  });

  const models = await provider.models();

  assert.equal(
    transport.requests[0]?.url,
    'https://api.anthropic.com/v1/models?beta=true',
  );

  assert.equal(transport.requests[0]?.method, 'GET');

  assert.deepEqual(models, [
    {
      id: 'claude-sonnet-4-5-20250929',
      name: 'Sonnet 4.5',
      provider: 'claude',
      raw: { id: 'claude-sonnet-4-5-20250929', display_name: 'Sonnet 4.5' },
    },
  ]);

  assert.deepEqual(
    await provider.validateModel('claude-sonnet-4-5-20250929'),
    models[0],
  );

  await assert.rejects(
    provider.validateModel('nope'),
    (error: unknown) =>
      error instanceof ProviderErrorObject &&
      error.data.code === 'missing_model',
  );
});

void test('allows overriding the Anthropic base URL', async () => {
  const transport = fakeTransport({
    responses: [response(messageResponse([{ type: 'text', text: 'ok' }]))],
  });

  const provider = createClaudeProvider({
    transport,
    authorization: 'Bearer claude-token',
    baseUrl: 'https://claude.example.test/api',
    logger: silentLogger,
  });

  await provider.complete({
    model: 'claude-sonnet-4-5',
    messages: [{ role: 'user', content: 'Hi' }],
  });

  assert.equal(
    transport.requests[0]?.url,
    'https://claude.example.test/api/v1/messages?beta=true',
  );
});

void test('rejects embeddings and reranking with unsupported errors', async () => {
  const provider = createClaudeProvider({
    transport: fakeTransport({}),
    authorization: 'Bearer claude-token',
    logger: silentLogger,
  });

  await assert.rejects(
    provider.embedding({ model: 'embedding-model', input: 'A document.' }),
    (error: unknown) =>
      error instanceof ProviderErrorObject &&
      error.data.provider === 'claude' &&
      error.data.code === 'unsupported_embeddings',
  );

  await assert.rejects(
    provider.rerank({
      model: 'rerank-model',
      query: 'needle',
      documents: ['haystack'],
    }),
    (error: unknown) =>
      error instanceof ProviderErrorObject &&
      error.data.provider === 'claude' &&
      error.data.code === 'unsupported_reranking',
  );
});

void test('maps Anthropic errors through the shared HTTP rules', async () => {
  const transport = fakeTransport({
    responses: [
      response(
        {
          type: 'error',
          error: { type: 'authentication_error', message: 'invalid token' },
        },
        401,
      ),
      response(
        {
          type: 'error',
          error: { type: 'rate_limit_error', message: 'slow down' },
        },
        429,
      ),
    ],
  });

  const provider = createClaudeProvider({
    transport,
    authorization: 'Bearer claude-token',
    logger: silentLogger,
  });

  await assert.rejects(
    provider.complete({
      model: 'claude-sonnet-4-5',
      messages: [{ role: 'user', content: 'Hi' }],
    }),
    (error: unknown) =>
      error instanceof ProviderErrorObject &&
      error.data.code === 'auth_failed' &&
      error.data.retryable !== true,
  );

  await assert.rejects(
    provider.complete({
      model: 'claude-sonnet-4-5',
      messages: [{ role: 'user', content: 'Hi' }],
    }),
    (error: unknown) =>
      error instanceof ProviderErrorObject &&
      error.data.code === 'http_error' &&
      error.data.retryable === true,
  );
});
