import assert from 'node:assert/strict';
import test from 'node:test';

import { z } from 'zod';

import {
  claudeCatalogModel,
  claudeUserAgent,
  createClaudeProvider,
  HttpStreamError,
  ProviderErrorObject,
} from '../src/index.js';
import {
  createOpenAiProvider,
  type FakeTransport,
  fakeTransport,
  response,
  silentLogger,
} from './fakes.js';

interface RequestBody extends Record<string, unknown> {
  system?: readonly { readonly type: string; readonly text: string }[];
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
    reasoning: true,
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

  // No temperature reaches Claude: current models refuse any value.
  await provider.complete({
    model: 'claude-sonnet-4-5',
    messages: [{ role: 'user', content: 'Hi' }],
    temperature: 0,
  });
  assert.equal('temperature' in bodyOf(transport, 1), false);

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

  // Anthropic's input_tokens is the uncached remainder: the input count is
  // the whole prompt, with the cache writes and reads as its parts.
  assert.deepEqual(result.usage, {
    inputTokens: 14,
    outputTokens: 4,
    cacheWriteTokens: 5,
    cachedInputTokens: 6,
    totalTokens: 18,
  });
});

void test('sends only the Claude Code identity when no system message is present', async () => {
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

  // The last system block carries the prompt-cache marker; the top-level
  // marker caches the conversation's growing tail.
  assert.deepEqual(bodyOf(transport).system, [
    {
      type: 'text',
      text: "You are Claude Code, Anthropic's official CLI for Claude.",
      cache_control: { type: 'ephemeral' },
    },
  ]);
  assert.deepEqual(bodyOf(transport).cache_control, { type: 'ephemeral' });
});

void test('sends authored system messages after the Claude Code identity', async () => {
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

  // A subscription login is accepted only when the identity opens the
  // system prompt, so the caller's own text follows it.
  assert.deepEqual(bodyOf(transport).system, [
    {
      type: 'text',
      text: "You are Claude Code, Anthropic's official CLI for Claude.",
    },
    {
      type: 'text',
      text: 'First policy.\n\nSecond policy.',
      cache_control: { type: 'ephemeral' },
    },
  ]);
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

  assert.deepEqual(bodyOf(transport, 0).tool_choice, { type: 'any' });

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

void test('sends every tool choice as an object, with parallel calls turned off on it', async () => {
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
      inputSchema: { type: 'object' },
      outputSchema: { type: 'string' },
      strict: true,
    },
  ];
  const messages = [{ role: 'user' as const, content: 'Find it.' }];

  await provider.complete({
    model: 'claude-sonnet-4-5',
    messages,
    tools,
    toolChoice: 'auto',
  });
  await provider.complete({
    model: 'claude-sonnet-4-5',
    messages,
    tools,
    parallelToolCalls: false,
  });
  await provider.complete({
    model: 'claude-sonnet-4-5',
    messages,
    tools,
    toolChoice: 'none',
    parallelToolCalls: false,
  });

  assert.deepEqual(bodyOf(transport, 0).tool_choice, { type: 'auto' });
  assert.deepEqual(bodyOf(transport, 1).tool_choice, {
    type: 'auto',
    disable_parallel_tool_use: true,
  });
  assert.deepEqual(bodyOf(transport, 2).tool_choice, { type: 'none' });
});

void test('sends no empty text block: an empty turn is left out', async () => {
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
      { role: 'user', content: 'Answer briefly.' },
      { role: 'assistant', content: '' },
      { role: 'user', content: 'Try again.' },
    ],
  });

  // The turns the dropped one left side by side become one.
  assert.deepEqual(bodyOf(transport).messages, [
    {
      role: 'user',
      content: [
        { type: 'text', text: 'Answer briefly.' },
        { type: 'text', text: 'Try again.' },
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
          is_error: true,
        },
      ],
    },
  ]);
});

void test('sends a tool result image beside its text, in order', async () => {
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
      { role: 'user', content: 'Look at it.' },
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'toolu_1', name: 'view-image', arguments: '{}' }],
      },
      {
        role: 'tool',
        toolCallId: 'toolu_1',
        content: [
          { type: 'text', text: '[Image: shot.png]' },
          { type: 'image', imageUrl: 'data:image/png;base64,AAAA' },
        ],
      },
    ],
  });

  // The view-image tool promises the image comes back with the result.
  assert.deepEqual(bodyOf(transport).messages?.at(-1), {
    role: 'user',
    content: [
      {
        type: 'tool_result',
        tool_use_id: 'toolu_1',
        content: [
          { type: 'text', text: '[Image: shot.png]' },
          {
            type: 'image',
            source: { type: 'base64', media_type: 'image/png', data: 'AAAA' },
          },
        ],
      },
    ],
  });
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

  // A plain request stays under the HTTP timeouts; a stream defaults higher.
  assert.equal(bodyOf(transport, 0).max_tokens, 16000);

  assert.equal(bodyOf(transport, 1).max_tokens, 100);
});

void test('sends the request effort at a level the model takes, and none where it takes none', async () => {
  const cases: readonly {
    readonly model: string;
    readonly effort: 'none' | 'minimal' | 'low' | 'high' | 'xhigh' | 'max';
    readonly sent: string | undefined;
  }[] = [
    { model: 'claude-opus-5-5', effort: 'xhigh', sent: 'xhigh' },
    { model: 'claude-opus-5-5', effort: 'minimal', sent: 'low' },
    { model: 'claude-opus-5-5', effort: 'none', sent: 'low' },
    { model: 'claude-opus-4-7', effort: 'max', sent: 'max' },
    // Opus 4.6 has no xhigh: it steps down to high.
    { model: 'claude-opus-4-6', effort: 'xhigh', sent: 'high' },
    { model: 'claude-sonnet-4-6', effort: 'max', sent: 'max' },
    // Haiku 4.5 and Sonnet 4.5 take no effort at all.
    { model: 'claude-haiku-4-5', effort: 'high', sent: undefined },
    { model: 'claude-sonnet-4-5-20250929', effort: 'low', sent: undefined },
  ];
  const transport = fakeTransport({
    responses: cases.map(() =>
      response(messageResponse([{ type: 'text', text: 'ok' }])),
    ),
  });
  const provider = createClaudeProvider({
    transport,
    authorization: 'Bearer claude-token',
    logger: silentLogger,
  });

  for (const entry of cases) {
    await provider.complete({
      model: entry.model,
      messages: [{ role: 'user', content: 'Hi' }],
      effort: entry.effort,
    });
  }

  assert.deepEqual(
    cases.map((_, index) => {
      const config = bodyOf(transport, index).output_config as
        | { effort?: string }
        | undefined;
      return config?.effort;
    }),
    cases.map((entry) => entry.sent),
  );
  // Effort never travels as a top-level field.
  assert.equal('effort' in bodyOf(transport, 0), false);
});

void test('keeps thinking on, with drop-on-mismatch binding, only on models that think by default', async () => {
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
    model: 'claude-opus-5-5',
    messages: [{ role: 'user', content: 'Hi' }],
  });
  await provider.complete({
    model: 'claude-opus-4-8',
    messages: [{ role: 'user', content: 'Hi' }],
  });

  // A rewritten history (compaction) drops the blocks it invalidated
  // instead of being refused; the field needs its beta.
  assert.deepEqual(bodyOf(transport, 0).thinking, {
    type: 'adaptive',
    block_binding: { prefix_mismatch_behavior: 'drop_block' },
  });
  assert.equal(
    transport.requests[0]?.headers?.['anthropic-beta'],
    'oauth-2025-04-20,claude-code-20250219,thinking-binding-controls-2026-08-01',
  );
  // Opus 4.8 does not think unless asked: nothing turns it on.
  assert.equal('thinking' in bodyOf(transport, 1), false);
  assert.equal(
    transport.requests[1]?.headers?.['anthropic-beta'],
    'oauth-2025-04-20,claude-code-20250219',
  );
});

void test('sends a stored value under the auth header it names', async () => {
  const cases = [
    {
      value: 'Bearer sk-ant-oat01-login',
      headers: { authorization: 'Bearer sk-ant-oat01-login' },
    },
    // A `claude setup-token` value is pasted bare.
    {
      value: 'sk-ant-oat01-setup',
      headers: { authorization: 'Bearer sk-ant-oat01-setup' },
    },
    // A Console API key is only accepted as x-api-key.
    { value: 'sk-ant-api03-key', headers: { 'x-api-key': 'sk-ant-api03-key' } },
  ];

  for (const entry of cases) {
    const transport = fakeTransport({
      responses: [response(messageResponse([{ type: 'text', text: 'ok' }]))],
    });
    const provider = createClaudeProvider({
      transport,
      authorization: entry.value,
      logger: silentLogger,
    });

    await provider.complete({
      model: 'claude-sonnet-4-5',
      messages: [{ role: 'user', content: 'Hi' }],
    });

    const sent = transport.requests[0]?.headers ?? {};
    assert.deepEqual(
      {
        ...(sent.authorization === undefined
          ? {}
          : { authorization: sent.authorization }),
        ...(sent['x-api-key'] === undefined
          ? {}
          : { 'x-api-key': sent['x-api-key'] }),
      },
      entry.headers,
    );
  }
});

void test('never ends a request on an assistant answer, which would be a prefill', async () => {
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
    model: 'claude-opus-5-5',
    messages: [
      { role: 'user', content: 'Summarize.' },
      { role: 'assistant', content: 'Here is the summary.' },
    ],
  });
  await provider.complete({
    model: 'claude-opus-5-5',
    messages: [
      { role: 'user', content: 'Look it up.' },
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'toolu_1', name: 'lookup', arguments: '{}' }],
      },
      { role: 'tool', toolCallId: 'toolu_1', content: 'found' },
    ],
  });

  assert.deepEqual(bodyOf(transport, 0).messages?.at(-1), {
    role: 'user',
    content: [
      {
        type: 'text',
        text: 'Continue from where your previous response ended.',
      },
    ],
  });
  // A history that ends on tool results already ends on the user.
  const last = bodyOf(transport, 1).messages?.at(-1) as
    | { readonly role?: string }
    | undefined;
  assert.equal(last?.role, 'user');
  assert.equal(bodyOf(transport, 1).messages?.length, 3);
});

void test('a model that refuses forced tool use gets auto instead', async () => {
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
  const tools = [
    {
      name: 'lookup',
      description: 'Search docs',
      inputSchema: { type: 'object' },
      outputSchema: { type: 'string' },
      strict: true,
    },
  ];

  await provider.complete({
    model: 'claude-opus-5-5',
    messages: [{ role: 'user', content: 'Find it.' }],
    tools,
    toolChoice: 'required',
    parallelToolCalls: false,
  });
  await provider.complete({
    model: 'claude-fable-5-1',
    messages: [{ role: 'user', content: 'Find it.' }],
    tools,
    toolChoice: { name: 'lookup' },
  });

  assert.deepEqual(bodyOf(transport, 0).tool_choice, {
    type: 'auto',
    disable_parallel_tool_use: true,
  });
  assert.deepEqual(bodyOf(transport, 1).tool_choice, { type: 'auto' });
});

void test('replays a thinking turn byte-for-byte and ignores another provider replay', async () => {
  const thinking = {
    type: 'thinking',
    thinking: 'Plan the lookup.',
    signature: 'sig-1',
  };
  const transport = fakeTransport({
    responses: [
      response(
        messageResponse(
          [
            thinking,
            { type: 'text', text: 'Looking.' },
            {
              type: 'tool_use',
              id: 'toolu_1',
              name: 'lookup',
              input: { q: 'x' },
            },
          ],
          { model: 'claude-opus-5-5', stop_reason: 'tool_use' },
        ),
      ),
      response(messageResponse([{ type: 'text', text: 'Done.' }])),
      response(messageResponse([{ type: 'text', text: 'Done.' }])),
    ],
  });
  const provider = createClaudeProvider({
    transport,
    authorization: 'Bearer claude-token',
    logger: silentLogger,
  });

  const first = await provider.complete({
    model: 'claude-opus-5-5',
    messages: [{ role: 'user', content: 'Find x.' }],
  });

  assert.ok(first.replay !== undefined, 'A thinking turn keeps its replay.');
  await provider.complete({
    model: 'claude-opus-5-5',
    messages: [
      { role: 'user', content: 'Find x.' },
      {
        role: 'assistant',
        content: first.text,
        toolCalls: first.toolCalls,
        replay: first.replay,
      },
      { role: 'tool', toolCallId: 'toolu_1', content: 'found' },
    ],
  });
  // An OpenAI reasoning item is not Claude's to send.
  await provider.complete({
    model: 'claude-opus-5-5',
    messages: [
      { role: 'user', content: 'Find x.' },
      {
        role: 'assistant',
        content: 'Done.',
        replay: [{ type: 'reasoning', id: 'rs_1', summary: [] }],
      },
      { role: 'user', content: 'Thanks.' },
    ],
  });

  assert.deepEqual(bodyOf(transport, 1).messages?.[1], {
    role: 'assistant',
    content: [
      thinking,
      { type: 'text', text: 'Looking.' },
      { type: 'tool_use', id: 'toolu_1', name: 'lookup', input: { q: 'x' } },
    ],
  });
  assert.deepEqual(bodyOf(transport, 2).messages?.[1], {
    role: 'assistant',
    content: [{ type: 'text', text: 'Done.' }],
  });
});

void test('a refused answer keeps no text or calls and says why', async () => {
  const transport = fakeTransport({
    responses: [
      response(
        messageResponse(
          [
            { type: 'text', text: 'Sure, the exploit' },
            { type: 'tool_use', id: 'toolu_1', name: 'run', input: {} },
          ],
          {
            stop_reason: 'refusal',
            stop_details: {
              type: 'refusal',
              category: 'cyber',
              explanation: 'Unsafe request.',
            },
          },
        ),
      ),
    ],
  });
  const provider = createClaudeProvider({
    transport,
    authorization: 'Bearer claude-token',
    logger: silentLogger,
  });

  const result = await provider.complete({
    model: 'claude-opus-5-5',
    messages: [{ role: 'user', content: 'Hi' }],
  });

  assert.equal(result.finishReason, 'content_filter');
  assert.equal(result.text, '');
  assert.deepEqual(result.toolCalls, []);
  assert.equal(
    result.refusal,
    'Claude declined to answer (cyber): Unsafe request.',
  );
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
    body.system?.[1]?.text ?? '',
    /^Follow policy\.[\s\S]*Return exactly one JSON object[\s\S]*JSON Schema/u,
  );

  assert.deepEqual(body.messages, [
    { role: 'user', content: [{ type: 'text', text: 'Return JSON.' }] },
  ]);
});

void test('lists every model page with its context window and validates a named model', async () => {
  const sonnet = {
    id: 'claude-sonnet-4-5-20250929',
    display_name: 'Sonnet 4.5',
    max_input_tokens: 200000,
  };
  const opus = {
    id: 'claude-opus-5-5',
    display_name: 'Opus 5.5',
    max_input_tokens: 1000000,
  };
  const pages = () => [
    response({
      data: [sonnet, { id: '', display_name: 'Empty' }],
      has_more: true,
      last_id: sonnet.id,
    }),
    response({ data: [opus], has_more: false }),
  ];
  const transport = fakeTransport({
    responses: [...pages(), ...pages(), ...pages(), ...pages()],
  });

  const provider = createClaudeProvider({
    transport,
    authorization: 'Bearer claude-token',
    logger: silentLogger,
  });

  const models = await provider.models();

  assert.deepEqual(
    transport.requests.map((request) => request.url),
    [
      'https://api.anthropic.com/v1/models?beta=true&limit=1000',
      'https://api.anthropic.com/v1/models?beta=true&limit=1000&after_id=claude-sonnet-4-5-20250929',
    ],
  );

  assert.equal(transport.requests[0]?.method, 'GET');

  assert.deepEqual(models, [
    {
      id: sonnet.id,
      name: 'Sonnet 4.5',
      contextWindow: 200000,
      provider: 'claude',
      raw: sonnet,
    },
    {
      id: opus.id,
      name: 'Opus 5.5',
      contextWindow: 1000000,
      provider: 'claude',
      raw: opus,
    },
  ]);

  assert.deepEqual(await provider.validateModel(sonnet.id), models[0]);
  // The alias a user types names the dated model the catalog lists.
  assert.deepEqual(
    await provider.validateModel('claude-sonnet-4-5'),
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

void test('a refused request says what Anthropic said, how long to wait and which request it was', async () => {
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
        { 'retry-after': '7', 'request-id': 'req_1' },
      ),
      response(
        {
          type: 'error',
          error: {
            type: 'invalid_request_error',
            message: 'prompt is too long: 210000 tokens > 200000 maximum',
          },
        },
        400,
      ),
      response(
        {
          type: 'error',
          error: {
            type: 'rate_limit_error',
            message: 'spend limit reached',
            details: { error_code: 'enforced_spend_limit_reached' },
          },
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
  const failure = async (): Promise<ProviderErrorObject> => {
    try {
      await provider.complete({
        model: 'claude-sonnet-4-5',
        messages: [{ role: 'user', content: 'Hi' }],
      });
    } catch (error) {
      if (error instanceof ProviderErrorObject) return error;
      throw error;
    }
    assert.fail('Expected the request to fail.');
  };

  const auth = await failure();
  assert.equal(auth.data.code, 'auth_failed');
  assert.notEqual(auth.data.retryable, true);
  assert.match(auth.message, /invalid token/);
  assert.match(auth.message, /Sign in with Claude again/);

  const limited = await failure();
  assert.equal(limited.data.code, 'http_error');
  assert.equal(limited.data.retryable, true);
  assert.equal(limited.data.retryAfterMs, 7000);
  assert.equal(limited.data.requestId, 'req_1');

  // The text a context-overflow check reads is in the message itself.
  const overflow = await failure();
  assert.match(overflow.message, /prompt is too long/);

  // A spend cap stays reached however long a retry waits.
  const capped = await failure();
  assert.equal(capped.data.retryable, false);
});

void test('a stream refused before it opens says what Anthropic said', async () => {
  const provider = createClaudeProvider({
    transport: {
      request: () => Promise.reject(new Error('no catalog')),
      // biome-ignore lint/correctness/useYield: the stream is refused before it yields
      async *stream() {
        throw new HttpStreamError(
          400,
          JSON.stringify({
            type: 'error',
            error: {
              type: 'invalid_request_error',
              message: 'prompt is too long: 210000 tokens > 200000 maximum',
            },
          }),
          { 'request-id': 'req_9' },
        );
      },
    },
    authorization: 'Bearer claude-token',
    logger: silentLogger,
  });

  await assert.rejects(
    (async () => {
      for await (const _event of provider.stream({
        model: 'claude-haiku-4-5',
        messages: [{ role: 'user', content: 'Hi' }],
      })) {
        // Drained until the refusal.
      }
    })(),
    (error: unknown) =>
      error instanceof ProviderErrorObject &&
      /prompt is too long/.test(error.message) &&
      error.data.requestId === 'req_9',
  );
});

void test('another provider never replays a Claude turn', async () => {
  const transport = fakeTransport({
    responses: [
      response({
        id: 'resp_1',
        output: [
          {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: 'ok' }],
          },
        ],
      }),
    ],
  });
  const openai = createOpenAiProvider({ transport, apiKey: 'sk-test' });

  await openai.complete({
    model: 'gpt-5',
    messages: [
      { role: 'user', content: 'Find x.' },
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'call_1', name: 'lookup', arguments: '{}' }],
        replay: [
          {
            provider: 'claude',
            block: { type: 'thinking', thinking: 'Plan.', signature: 'sig' },
          },
        ],
      },
      { role: 'tool', toolCallId: 'call_1', content: 'found' },
    ],
  });

  const input = (
    JSON.parse(transport.requests[0]?.body ?? '{}') as {
      input: readonly Record<string, unknown>[];
    }
  ).input;
  assert.equal(
    input.some((item) => 'provider' in item || 'block' in item),
    false,
  );
  assert.ok(input.some((item) => item.type === 'function_call'));
});

void test('a listed model becomes a catalog entry with the efforts its capabilities mark supported, weakest first', () => {
  const listed = (raw: Record<string, unknown>) =>
    claudeCatalogModel({
      id: String(raw.id),
      name: raw.display_name as string | undefined,
      raw,
    });
  const effort = (levels: Readonly<Record<string, boolean>>) => ({
    supported: Object.values(levels).some(Boolean),
    ...Object.fromEntries(
      Object.entries(levels).map(([level, supported]) => [
        level,
        { supported },
      ]),
    ),
  });

  // The capability order Anthropic sends is not the order kept.
  assert.deepEqual(
    listed({
      id: 'claude-opus-5-5',
      display_name: 'Claude Opus 5.5',
      capabilities: {
        effort: effort({
          max: true,
          low: true,
          xhigh: true,
          high: true,
          medium: true,
        }),
      },
    }),
    {
      id: 'claude-opus-5-5',
      name: 'Claude Opus 5.5',
      reasonings: ['low', 'medium', 'high', 'xhigh', 'max'],
      parameters: [],
      defaultEffort: 'medium',
      mandatory: false,
    },
  );
  assert.deepEqual(
    listed({
      id: 'claude-haiku-5-5',
      capabilities: {
        effort: effort({ low: true, medium: true, high: true }),
      },
    }).defaultEffort,
    'medium',
  );
  assert.deepEqual(
    listed({
      id: 'claude-opus-4-6',
      capabilities: {
        effort: effort({ low: true, medium: true, high: true, max: true }),
      },
    }),
    {
      id: 'claude-opus-4-6',
      reasonings: ['low', 'medium', 'high', 'max'],
      parameters: [],
      defaultEffort: 'high',
      mandatory: false,
    },
  );
  // A model that takes no effort lists none and starts at none.
  assert.deepEqual(
    listed({
      id: 'claude-haiku-4-5-20251001',
      capabilities: { effort: { supported: false } },
    }),
    {
      id: 'claude-haiku-4-5-20251001',
      reasonings: [],
      parameters: [],
      mandatory: false,
    },
  );
});

void test('a listed model without capabilities takes the efforts its id names', () => {
  const entry = (id: string) =>
    claudeCatalogModel({ id, raw: { id, display_name: id } });

  assert.deepEqual(entry('claude-sonnet-5-5').reasonings, [
    'low',
    'medium',
    'high',
    'xhigh',
    'max',
  ]);
  assert.equal(entry('claude-sonnet-5-5').defaultEffort, 'high');
  assert.deepEqual(entry('claude-sonnet-4-6').reasonings, [
    'low',
    'medium',
    'high',
    'max',
  ]);
  assert.deepEqual(entry('claude-haiku-4-5').reasonings, []);
  assert.deepEqual(entry('some-future-model').reasonings, []);
  assert.equal(entry('claude-sonnet-5-5').name, 'claude-sonnet-5-5');
});
