import assert from 'node:assert/strict';
import test from 'node:test';

import { z } from 'zod';

import { createToolStorage, defineTool } from 'tool';

import {
  createOpenAiCompatibleProvider,
  openAiBody,
  ProviderErrorObject,
} from '../src/index.js';
import { fakeTransport, response, silentLogger } from './fakes.js';

test('preserves configured identity in compatible metadata and errors', async () => {
  const provider = createOpenAiCompatibleProvider({
    transport: fakeTransport({ responses: [response({}, 503)] }),
    baseUrl: 'https://compatible.invalid/v1',
    identity: { id: 'configured', name: 'Configured' },
    apiKey: 'private-token',
    logger: silentLogger,
  });

  assert.deepEqual(provider.metadata, {
    id: 'configured',
    name: 'Configured',
    baseUrl: 'https://compatible.invalid/v1',
  });

  await assert.rejects(
    provider.complete({
      model: 'model',
      messages: [{ role: 'user', content: 'request' }],
    }),
    (error: unknown) =>
      error instanceof ProviderErrorObject &&
      error.data.provider === 'configured',
  );

  await assert.rejects(
    provider.complete({ model: '', messages: [] }),
    (error: unknown) =>
      error instanceof ProviderErrorObject &&
      error.data.provider === 'configured',
  );
});

test('preserves compatible identity in credential validation errors', async () => {
  const provider = createOpenAiCompatibleProvider({
    transport: fakeTransport({}),
    baseUrl: 'https://compatible.invalid/v1',
    identity: { id: 'configured', name: 'Configured' },
    apiKey: 'private-token',
    authorization: 'Bearer private-token',
    logger: silentLogger,
  });

  await assert.rejects(
    provider.models(),
    (error: unknown) =>
      error instanceof ProviderErrorObject &&
      error.data.provider === 'configured' &&
      error.data.message.startsWith('Configured provider'),
  );
});

test('maps OpenAI Responses DTO with instructions tools reasoning and fast service tier', () => {
  const body = openAiBody(
    {
      model: 'gpt-5-fast',
      messages: [
        { role: 'system', content: 'Follow policy.' },
        { role: 'user', content: 'Plan it.' },
        { role: 'tool', toolCallId: 'call_1', content: 'tool output' },
      ],
      tools: [
        {
          name: 'search',
          description: 'Search docs',
          inputSchema: { type: 'object', properties: {} },
          outputSchema: {},
          strict: true,
        },
      ],
      maxOutputTokens: 100,
      flags: { reasoning: { effort: 'low', summary: 'concise' } },
    },
    false,
  );

  assert.equal(body.model, 'gpt-5');

  assert.equal(body.instructions, 'Follow policy.');

  assert.equal(body.service_tier, 'priority');

  assert.deepEqual(body.reasoning, { effort: 'low', summary: 'concise' });

  assert.deepEqual(body.tools, [
    {
      type: 'function',
      name: 'search',
      description: 'Search docs',
      parameters: {
        type: 'object',
        properties: {},
      },
      strict: false,
    },
  ]);

  assert.deepEqual(body.input, [
    {
      role: 'user',
      content: [{ type: 'input_text', text: 'Plan it.' }],
    },
    {
      type: 'function_call_output',
      call_id: 'call_1',
      output: 'tool output',
    },
  ]);

  assert.equal('text' in body, false);

  assert.equal(body.store, false);
});

test('maps top-level OpenAI effort before legacy reasoning effort', () => {
  const body = openAiBody(
    {
      model: 'gpt-5',
      messages: [{ role: 'user', content: 'Plan it.' }],
      effort: 'xhigh',
      flags: { reasoning: { effort: 'low', summary: 'concise' } },
    },
    false,
  );

  assert.deepEqual(body.reasoning, { effort: 'xhigh', summary: 'concise' });
});

test('maps assistant tool calls to Responses function call input items', () => {
  const body = openAiBody(
    {
      model: 'gpt-5',
      messages: [
        { role: 'user', content: 'Find it.' },
        {
          role: 'assistant',
          content: '',
          toolCalls: [
            { id: 'call_1', name: 'lookup', arguments: '{"query":"x"}' },
          ],
        },
        { role: 'tool', toolCallId: 'call_1', content: 'tool output' },
      ],
    },
    false,
  );

  assert.deepEqual(body.input, [
    {
      role: 'user',
      content: [{ type: 'input_text', text: 'Find it.' }],
    },
    {
      type: 'function_call',
      call_id: 'call_1',
      name: 'lookup',
      arguments: '{"query":"x"}',
    },
    {
      type: 'function_call_output',
      call_id: 'call_1',
      output: 'tool output',
    },
  ]);
});

test('omits assistant text while keeping Responses function call input items', () => {
  const body = openAiBody(
    {
      model: 'gpt-5',
      messages: [
        { role: 'user', content: 'Plan it.' },
        {
          role: 'assistant',
          content: 'I will inspect first.',
          toolCalls: [
            { id: 'call_1', name: 'read_file', arguments: '{"path":"x"}' },
          ],
        },
      ],
    },
    false,
  );

  assert.deepEqual(body.input, [
    {
      role: 'user',
      content: [{ type: 'input_text', text: 'Plan it.' }],
    },
    {
      type: 'function_call',
      call_id: 'call_1',
      name: 'read_file',
      arguments: '{"path":"x"}',
    },
  ]);
});

test('omits assistant text-only messages from Responses input items', () => {
  const body = openAiBody(
    {
      model: 'gpt-5',
      messages: [
        { role: 'user', content: 'Plan it.' },
        { role: 'assistant', content: 'I will inspect first.' },
      ],
    },
    false,
  );

  assert.deepEqual(body.input, [
    {
      role: 'user',
      content: [{ type: 'input_text', text: 'Plan it.' }],
    },
  ]);
});

test('does not mutate strict OpenAI tool schemas with optional properties', () => {
  const inputSchema = {
    type: 'object',
    properties: {
      pattern: { type: 'string' },
      path: { type: 'string' },
      limit: { type: 'integer' },
    },
    required: ['pattern'],
    additionalProperties: false,
  } as const;

  const body = openAiBody(
    {
      model: 'gpt-5',
      messages: [{ role: 'user', content: 'Find files.' }],
      tools: [
        {
          name: 'find',
          description: 'Find files',
          inputSchema,
          outputSchema: {},
          strict: true,
        },
      ],
    },
    false,
  );

  assert.deepEqual(body.tools, [
    {
      type: 'function',
      name: 'find',
      description: 'Find files',
      parameters: {
        type: 'object',
        properties: inputSchema.properties,
        required: ['pattern'],
        additionalProperties: false,
      },
      strict: false,
    },
  ]);

  assert.deepEqual(inputSchema.required, ['pattern']);
});

test('maps OpenAI structured output schemas to text format DTOs', () => {
  const body = openAiBody(
    {
      model: 'gpt-5',
      messages: [{ role: 'user', content: 'Return JSON.' }],
      schema: z.object({ answer: z.string() }),
    },
    false,
  );

  assert.deepEqual(body.text, {
    format: {
      type: 'json_schema',
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

test('adds a schema system instruction while retaining OpenAI text format', () => {
  const body = openAiBody(
    {
      model: 'gpt-5',
      messages: [
        { role: 'system', content: 'First policy.' },
        { role: 'system', content: 'Second policy.' },
        { role: 'user', content: 'Return JSON.' },
      ],
      schema: z.object({ answer: z.string() }),
      flags: { includeStructuredSchemaOnSystemPrompt: true },
    },
    false,
  );

  assert.match(
    body.instructions as string,
    /^First policy\.\n\nSecond policy\.[\s\S]*Return exactly one JSON object[\s\S]*JSON Schema/u,
  );

  assert.equal(
    (body.text as { readonly format?: { readonly type?: string } }).format
      ?.type,
    'json_schema',
  );

  assert.deepEqual(body.input, [
    {
      role: 'user',
      content: [{ type: 'input_text', text: 'Return JSON.' }],
    },
  ]);
});

test('maps OpenAI nested union structured output schemas to text format DTOs', () => {
  const body = openAiBody(
    {
      model: 'gpt-5',
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

  const text = body.text as {
    readonly format?: {
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
  const variants = text.format?.schema?.properties?.action?.anyOf;

  assert.equal(text.format?.schema?.type, 'object');

  assert.ok(Array.isArray(variants));

  assert.equal(variants.length, 2);

  assert.deepEqual(
    variants.map((variant) => (variant as Record<string, unknown>).required),
    [
      ['type', 'question'],
      ['type', 'answer'],
    ],
  );

  assert.deepEqual(
    variants.map(
      (variant) => (variant as Record<string, unknown>).additionalProperties,
    ),
    [false, false],
  );
});

test('rejects OpenAI top-level union structured output schemas', () => {
  const request = {
    model: 'gpt-5',
    messages: [{ role: 'user', content: 'Return JSON.' }],
  } as const;

  const topLevelUnion = z.union([
    z.object({ type: z.literal('question'), question: z.string() }),
    z.object({ type: z.literal('answer'), answer: z.string() }),
  ]);

  const topLevelDiscriminatedUnion = z.discriminatedUnion('type', [
    z.object({ type: z.literal('question'), question: z.string() }),
    z.object({ type: z.literal('answer'), answer: z.string() }),
  ]);

  const rejectsInvalidStructuredSchema = (error: unknown) =>
    error instanceof ProviderErrorObject &&
    error.data.code === 'invalid_structured_schema';

  assert.throws(
    () => openAiBody({ ...request, schema: topLevelUnion }, false),
    rejectsInvalidStructuredSchema,
  );

  assert.throws(
    () => openAiBody({ ...request, schema: topLevelDiscriminatedUnion }, false),
    rejectsInvalidStructuredSchema,
  );
});

test('keeps nested optional structured output properties non-strict', () => {
  const body = openAiBody(
    {
      model: 'gpt-5',
      messages: [{ role: 'user', content: 'Ask follow-up questions.' }],
      schema: z.object({
        questions: z.array(
          z.object({
            prompt: z.string(),
            impact: z.string().optional(),
          }),
        ),
      }),
    },
    false,
  );

  assert.deepEqual(body.text, {
    format: {
      type: 'json_schema',
      name: 'structured_output',
      strict: false,
      schema: {
        $schema: 'https://json-schema.org/draft/2020-12/schema',
        type: 'object',
        properties: {
          questions: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                prompt: { type: 'string' },
                impact: { type: 'string' },
              },
              required: ['prompt'],
              additionalProperties: false,
            },
          },
        },
        required: ['questions'],
        additionalProperties: false,
      },
    },
  });
});

test('maps tool controls and replays opaque Responses output items', () => {
  const replay = [
    { type: 'reasoning', encrypted_content: 'opaque' },
    {
      type: 'function_call',
      call_id: 'call_1',
      name: 'lookup',
      arguments: '{"query":"x"}',
    },
  ] as const;

  const body = openAiBody(
    {
      model: 'gpt-5',
      messages: [
        { role: 'user', content: 'Find it.' },
        { role: 'assistant', replay },
        {
          role: 'tool',
          toolCallId: 'call_1',
          toolResultStatus: 'incomplete',
          content: 'Invalid payload.',
        },
      ],
      toolChoice: { name: 'lookup' },
      parallelToolCalls: false,
    },
    false,
  );

  assert.deepEqual(body.tool_choice, { type: 'function', name: 'lookup' });

  assert.equal(body.parallel_tool_calls, false);

  assert.deepEqual(body.input, [
    {
      role: 'user',
      content: [{ type: 'input_text', text: 'Find it.' }],
    },
    ...replay,
    {
      type: 'function_call_output',
      call_id: 'call_1',
      output: 'Invalid payload.',
      status: 'incomplete',
    },
  ]);
});

test('accepts tool definitions from shared tool storage', () => {
  const tools = createToolStorage([
    defineTool({
      name: 'lookup',
      description: 'Lookup context',
      input: z.object({ query: z.string() }),
      output: z.string(),
      execute: (_sandbox, { query }) => query,
    })(undefined as never),
  ]);

  const body = openAiBody(
    {
      model: 'gpt-5',
      messages: [{ role: 'user', content: 'Use the tool.' }],
      tools: tools.definitions(),
    },
    false,
  );

  assert.deepEqual(body.tools, [
    {
      type: 'function',
      name: 'lookup',
      description: 'Lookup context',
      parameters: tools.definitions()[0]?.inputSchema,
      strict: true,
    },
  ]);
});
