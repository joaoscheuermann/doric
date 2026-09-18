import assert from 'node:assert/strict';
import test from 'node:test';

import { z } from 'zod';

import { ProviderErrorObject, type ProviderStreamEvent } from '../src/index.js';
import {
  collect,
  createLmStudioProvider,
  fakeTransport,
  response,
} from './fakes.js';

const schema = z.object({
  answer: z.string().describe('May contain ```json without ending the fence.'),
});

const assertSchemaInstruction = (prompt: string): void => {
  assert.match(prompt, /Return exactly one JSON object/u);

  assert.match(prompt, /JSON Schema/u);

  assert.match(prompt, /~~~json\n\{/u);

  assert.match(prompt, /\n\}\n~~~/u);

  assert.match(prompt, /"answer"/u);
};

test('sends LM Studio chat requests to the default native endpoint without auth', async () => {
  const transport = fakeTransport({
    responses: [
      response({
        output: [
          { type: 'reasoning', content: 'Thinking.' },
          { type: 'message', content: 'Done.' },
          { type: 'tool_call', content: 'native tool call' },
        ],
        stats: {
          input_tokens: 3,
          total_output_tokens: 5,
          reasoning_output_tokens: 2,
        },
      }),
    ],
  });
  const provider = createLmStudioProvider({ transport });

  const result = await provider.complete({
    model: 'qwen3-coder-fast',
    messages: [
      { role: 'system', content: 'Follow policy.' },
      { role: 'user', content: 'Hi' },
    ],
    temperature: 0.2,
    maxOutputTokens: 64,
    flags: {
      reasoning: { effort: 'low' },
      serviceTier: 'priority',
    },
  });
  const body = JSON.parse(transport.requests[0]?.body ?? '{}');

  assert.equal(provider.metadata.id, 'lmstudio');

  assert.equal(provider.metadata.name, 'LM Studio');

  assert.equal(provider.metadata.baseUrl, 'http://localhost:1234');

  assert.equal(provider.capabilities.tools, false);

  assert.equal(provider.capabilities.reasoning, true);

  assert.equal(provider.capabilities.serviceTier, false);

  assert.equal(transport.requests[0]?.url, 'http://localhost:1234/api/v1/chat');

  assert.equal(
    'authorization' in (transport.requests[0]?.headers ?? {}),
    false,
  );

  assert.deepEqual(body, {
    model: 'qwen3-coder-fast',
    input: 'Hi',
    system_prompt: 'Follow policy.',
    stream: false,
    temperature: 0.2,
    max_output_tokens: 64,
    reasoning: 'low',
  });

  assert.equal('service_tier' in body, false);

  assert.equal(result.text, 'Done.');

  assert.deepEqual(result.reasoning, { text: 'Thinking.' });

  assert.deepEqual(result.usage, {
    inputTokens: 3,
    outputTokens: 5,
    totalTokens: 8,
    reasoningTokens: 2,
  });

  assert.deepEqual(result.toolCalls, []);
});

test('adds one structured schema instruction after authored native system messages', async () => {
  const transport = fakeTransport({
    responses: [
      response({
        output: [{ type: 'message', content: '{"answer":"Done"}' }],
      }),
    ],
  });
  const provider = createLmStudioProvider({ transport });

  const messages = [
    { role: 'system' as const, content: 'First policy.' },
    { role: 'system' as const, content: 'Second policy.' },
    { role: 'user' as const, content: 'Answer.' },
  ];

  const request = {
    model: 'local-model',
    messages,
    schema,
    flags: { includeStructuredSchemaOnSystemPrompt: true },
  } as const;
  const result = await provider.complete(request);
  const body = JSON.parse(transport.requests[0]?.body ?? '{}');

  assert.ok(
    body.system_prompt.startsWith('First policy.\n\nSecond policy.\n\n'),
  );

  assert.equal(body.system_prompt.match(/JSON Schema/gu)?.length, 1);

  assertSchemaInstruction(body.system_prompt);

  assert.equal(body.input, 'Answer.');

  assert.deepEqual(result.structured, { answer: 'Done' });

  assert.deepEqual(request.messages, messages);

  assert.equal(request.messages, messages);
});

test('uses the same structured schema instruction for native streams', async () => {
  const transport = fakeTransport({
    streams: [
      [
        sse('chat.end', {
          result: {
            output: [{ type: 'message', content: '{"answer":"Done"}' }],
          },
        }),
      ],
    ],
  });
  const provider = createLmStudioProvider({ transport });

  await collect(
    provider.stream({
      model: 'local-model',
      messages: [{ role: 'user', content: 'Answer.' }],
      schema,
      flags: { includeStructuredSchemaOnSystemPrompt: true },
    }),
  );

  const body = JSON.parse(transport.requests[0]?.body ?? '{}');

  assertSchemaInstruction(body.system_prompt);

  assert.equal(body.input, 'Answer.');
});

test('does not add schema instructions unless both the flag and schema are present', async () => {
  const transport = fakeTransport({
    responses: [
      response({
        output: [{ type: 'message', content: '{"answer":"Done"}' }],
      }),
      response({ output: [{ type: 'message', content: 'Done.' }] }),
    ],
  });
  const provider = createLmStudioProvider({ transport });

  await provider.complete({
    model: 'local-model',
    messages: [
      { role: 'system', content: 'Policy.' },
      { role: 'user', content: 'Answer.' },
    ],
    schema,
  });

  await provider.complete({
    model: 'local-model',
    messages: [
      { role: 'system', content: 'Policy.' },
      { role: 'user', content: 'Answer.' },
    ],
    flags: { includeStructuredSchemaOnSystemPrompt: true },
  });

  assert.deepEqual(
    transport.requests.map(
      (request) => JSON.parse(request.body ?? '{}').system_prompt,
    ),
    ['Policy.', 'Policy.'],
  );
});

test('normalizes top-level LM Studio reasoning effort values for native requests', async () => {
  const transport = fakeTransport({
    responses: [
      response({ output: [{ type: 'message', content: 'ok' }] }),
      response({ output: [{ type: 'message', content: 'ok' }] }),
      response({ output: [{ type: 'message', content: 'ok' }] }),
    ],
  });
  const provider = createLmStudioProvider({ transport });

  await provider.complete({
    model: 'local-model',
    messages: [{ role: 'user', content: 'Hi' }],
    effort: 'none',
  });

  await provider.complete({
    model: 'local-model',
    messages: [{ role: 'user', content: 'Hi' }],
    effort: 'minimal',
  });

  await provider.complete({
    model: 'local-model',
    messages: [{ role: 'user', content: 'Hi' }],
    effort: 'xhigh',
  });

  assert.deepEqual(
    transport.requests.map(
      (request) => JSON.parse(request.body ?? '{}').reasoning,
    ),
    ['off', 'low', 'high'],
  );
});

test('maps LM Studio authorization modes', async () => {
  const blank = fakeTransport({
    responses: [response({ output: [{ type: 'message', content: 'ok' }] })],
  });

  const apiKey = fakeTransport({
    responses: [response({ output: [{ type: 'message', content: 'ok' }] })],
  });

  const exact = fakeTransport({
    responses: [response({ output: [{ type: 'message', content: 'ok' }] })],
  });

  await createLmStudioProvider({
    transport: blank,
    apiKey: ' ',
    authorization: '\t',
  }).complete({
    model: 'local-model',
    messages: [{ role: 'user', content: 'Hi' }],
  });

  await createLmStudioProvider({
    transport: apiKey,
    apiKey: 'local-key',
  }).complete({
    model: 'local-model',
    messages: [{ role: 'user', content: 'Hi' }],
  });

  await createLmStudioProvider({
    transport: exact,
    authorization: 'Bearer session-token',
  }).complete({
    model: 'local-model',
    messages: [{ role: 'user', content: 'Hi' }],
  });

  assert.equal('authorization' in (blank.requests[0]?.headers ?? {}), false);

  assert.equal(apiKey.requests[0]?.headers?.authorization, 'Bearer local-key');

  assert.equal(
    exact.requests[0]?.headers?.authorization,
    'Bearer session-token',
  );
});

test('rejects ambiguous LM Studio authorization', async () => {
  const provider = createLmStudioProvider({
    transport: fakeTransport({}),
    apiKey: 'local-key',
    authorization: 'Bearer session-token',
  });

  await assert.rejects(
    provider.complete({
      model: 'local-model',
      messages: [{ role: 'user', content: 'Hi' }],
    }),
    (error: unknown) =>
      error instanceof ProviderErrorObject &&
      error.data.provider === 'lmstudio' &&
      error.data.code === 'auth_ambiguous',
  );
});

test('maps LM Studio named stream events to provider events', async () => {
  const transport = fakeTransport({
    streams: [
      [
        sse('chat.start', {}),
        sse('message.delta', { content: 'Hel' }),
        sse('reasoning.delta', { content: 'why' }),
        sse('message.delta', { content: 'lo' }),
        sse('chat.end', {
          result: {
            output: [{ type: 'message', content: 'Hello' }],
            stats: {
              input_tokens: 2,
              total_output_tokens: 3,
              reasoning_output_tokens: 1,
            },
          },
        }),
      ],
    ],
  });
  const provider = createLmStudioProvider({ transport });

  const events = await collect(
    provider.stream({
      model: 'local-model-fast',
      messages: [{ role: 'user', content: 'Hi' }],
    }),
  );
  const body = JSON.parse(transport.requests[0]?.body ?? '{}');
  const finished = events.at(-1);

  assert.equal(transport.requests[0]?.url, 'http://localhost:1234/api/v1/chat');

  assert.equal(body.model, 'local-model-fast');

  assert.equal(body.stream, true);

  assert.deepEqual(events[0], {
    type: 'response.started',
    provider: 'lmstudio',
    model: 'local-model-fast',
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
    events
      .filter(
        (event): event is ProviderStreamEvent & { type: 'reasoning.delta' } =>
          event.type === 'reasoning.delta',
      )
      .map((event) => event.delta),
    ['why'],
  );

  assert.ok(events.some((event) => event.type === 'usage'));

  assert.equal(finished?.type, 'response.finished');

  if (finished?.type !== 'response.finished') {
    assert.fail('Expected final response.finished event.');
  }

  assert.equal(finished.finish.text, 'Hello');

  assert.deepEqual(finished.finish.reasoning, { text: 'why' });

  assert.deepEqual(finished.finish.usage, {
    inputTokens: 2,
    outputTokens: 3,
    totalTokens: 5,
    reasoningTokens: 1,
  });
});

test('continues LM Studio streams after provider error events', async () => {
  const provider = createLmStudioProvider({
    transport: fakeTransport({
      streams: [
        [
          sse('message.delta', { content: 'Partial' }),
          sse('error', { error: { message: 'transient warning' } }),
          sse('chat.end', {
            result: {
              output: [{ type: 'message', content: 'Partial done' }],
              stats: {
                input_tokens: 1,
                total_output_tokens: 2,
                reasoning_output_tokens: 0,
              },
            },
          }),
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
  const error = events.find((event) => event.type === 'error');
  const finished = events.at(-1);

  assert.equal(error?.type, 'error');

  if (error?.type !== 'error') {
    assert.fail('Expected error event.');
  }

  assert.equal(error.error.provider, 'lmstudio');

  assert.equal(error.error.code, 'provider_error');

  assert.equal(error.error.message, 'transient warning');

  assert.equal(finished?.type, 'response.finished');

  if (finished?.type !== 'response.finished') {
    assert.fail('Expected final response.finished event.');
  }

  assert.ok(events.some((event) => event.type === 'usage'));

  assert.equal(finished.finish.text, 'Partial done');

  assert.deepEqual(finished.finish.usage, {
    inputTokens: 1,
    outputTokens: 2,
    totalTokens: 3,
    reasoningTokens: 0,
  });
});

test('maps LM Studio model identity and validation errors', async () => {
  const transport = fakeTransport({
    responses: [
      response({
        models: [
          {
            key: 'local-model',
            display_name: 'Local Model',
            type: 'llm',
            max_context_length: 4096,
          },
          {
            key: 'embed-model',
            display_name: 'Embed Model',
            type: 'embedding',
          },
        ],
      }),
      response({ models: [{ key: 'local-model', type: 'llm' }] }),
    ],
  });

  const provider = createLmStudioProvider({
    transport,
  });
  const models = await provider.models();

  assert.equal(provider.metadata.baseUrl, 'http://localhost:1234');

  assert.equal(
    transport.requests[0]?.url,
    'http://localhost:1234/api/v1/models',
  );

  assert.equal(
    'authorization' in (transport.requests[0]?.headers ?? {}),
    false,
  );

  assert.equal(models.length, 1);

  assert.deepEqual(models[0], {
    id: 'local-model',
    name: 'Local Model',
    contextWindow: 4096,
    provider: 'lmstudio',
    raw: {
      key: 'local-model',
      display_name: 'Local Model',
      type: 'llm',
      max_context_length: 4096,
    },
  });

  await assert.rejects(
    provider.validateModel('missing-model'),
    (error: unknown) =>
      error instanceof ProviderErrorObject &&
      error.data.provider === 'lmstudio' &&
      error.data.code === 'missing_model',
  );
});

test('sends LM Studio model requests with API key auth', async () => {
  const transport = fakeTransport({
    responses: [response({ models: [{ key: 'local-model', type: 'llm' }] })],
  });

  const provider = createLmStudioProvider({
    transport,
    apiKey: 'local-key',
  });

  await provider.models();

  assert.equal(
    transport.requests[0]?.url,
    'http://localhost:1234/api/v1/models',
  );

  assert.equal(
    transport.requests[0]?.headers?.authorization,
    'Bearer local-key',
  );
});

const sse = (event: string, payload: unknown): string =>
  `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
