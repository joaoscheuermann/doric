import assert from 'node:assert/strict';
import test from 'node:test';

import { z } from 'zod';

import { ProviderErrorObject } from '../src/index.js';
import {
  collect,
  createUnifiedProvider,
  fakeTransport,
  response,
} from './fakes.js';

const modelCatalog = (id: string, supportedParameters: readonly string[]) =>
  response({
    data: [
      {
        id,
        name: id,
        supported_parameters: supportedParameters,
      },
    ],
  });

test('selects native structured output from live OpenRouter capabilities', async () => {
  const transport = fakeTransport({
    responses: [
      modelCatalog('openai/gpt-5', [
        'tools',
        'tool_choice',
        'structured_outputs',
      ]),
      response({
        choices: [
          { finish_reason: 'stop', message: { content: '{"answer":"ok"}' } },
        ],
      }),
    ],
  });
  const provider = createUnifiedProvider({ transport, apiKey: 'key' });

  const result = await provider.complete({
    model: 'openai/gpt-5',
    messages: [{ role: 'user', content: 'Answer.' }],
    schema: z.object({ answer: z.string() }),
  });
  const body = JSON.parse(transport.requests[1]?.body ?? '{}') as Record<
    string,
    unknown
  >;

  assert.deepEqual(result.structured, { answer: 'ok' });
  assert.equal(
    (body.response_format as { readonly type?: string }).type,
    'json_schema',
  );
  assert.deepEqual(body.provider, { require_parameters: true });
});

test('falls back from JSON mode to a schema prompt and repairs locally', async () => {
  const transport = fakeTransport({
    responses: [
      modelCatalog('google/gemma-3-27b-it', []),
      response({
        choices: [
          { finish_reason: 'stop', message: { content: '{"answer":42}' } },
        ],
        usage: {
          prompt_tokens: 1,
          completion_tokens: 2,
          total_tokens: 3,
          cost: 0.01,
          cost_details: { upstream_inference_cost: 0.008 },
        },
      }),
      response({
        choices: [
          { finish_reason: 'stop', message: { content: '{"answer":"ok"}' } },
        ],
        usage: {
          prompt_tokens: 4,
          completion_tokens: 5,
          total_tokens: 9,
          cost: 0.02,
          cost_details: { upstream_inference_cost: 0.015 },
        },
      }),
    ],
  });
  const provider = createUnifiedProvider({ transport, apiKey: 'key' });

  const result = await provider.complete({
    model: 'google/gemma-3-27b-it',
    messages: [{ role: 'user', content: 'Answer.' }],
    schema: z.object({ answer: z.string() }),
  });
  const first = JSON.parse(transport.requests[1]?.body ?? '{}') as {
    readonly messages?: readonly { readonly role?: string; content?: string }[];
    readonly response_format?: unknown;
  };
  const second = JSON.parse(transport.requests[2]?.body ?? '{}') as {
    readonly messages?: readonly { readonly role?: string; content?: string }[];
  };

  assert.equal(first.response_format, undefined);
  assert.equal(first.messages?.[0]?.role, 'system');
  assert.match(first.messages?.[0]?.content ?? '', /JSON Schema/u);
  assert.match(
    second.messages?.at(-1)?.content ?? '',
    /Structured output correction/u,
  );
  assert.deepEqual(result.structured, { answer: 'ok' });
  assert.deepEqual(result.usage, {
    inputTokens: 5,
    outputTokens: 7,
    totalTokens: 12,
    cost: {
      amount: 0.03,
      unit: 'credits',
      upstreamAmount: 0.023,
    },
  });
});

test('buffers direct structured streams until validation succeeds', async () => {
  const transport = fakeTransport({
    responses: [
      modelCatalog('mistralai/mistral-small', ['response_format']),
      response({
        choices: [
          { finish_reason: 'stop', message: { content: '{"answer":"ok"}' } },
        ],
      }),
    ],
  });
  const provider = createUnifiedProvider({ transport, apiKey: 'key' });

  const events = await collect(
    provider.stream({
      model: 'mistralai/mistral-small',
      messages: [{ role: 'user', content: 'Answer.' }],
      schema: z.object({ answer: z.string() }),
    }),
  );

  assert.deepEqual(
    events.map(({ type }) => type),
    ['response.started', 'text.delta', 'response.finished'],
  );
  assert.equal(transport.requests.length, 2);
  assert.equal(transport.requests[1]?.headers?.accept, 'application/json');
});

test('rejects non-emulatable feature combinations before completion', async () => {
  const transport = fakeTransport({
    responses: [modelCatalog('anthropic/claude-sonnet-4', ['tools'])],
  });
  const provider = createUnifiedProvider({ transport, apiKey: 'key' });

  await assert.rejects(
    provider.complete({
      model: 'anthropic/claude-sonnet-4',
      messages: [{ role: 'user', content: 'Use a tool.' }],
      tools: [
        { name: 'lookup', inputSchema: { type: 'object' }, outputSchema: {} },
      ],
      toolChoice: 'required',
      effort: 'high',
    }),
    (error: unknown) =>
      error instanceof ProviderErrorObject &&
      error.data.code === 'incompatible_model_request',
  );
  assert.equal(transport.requests.length, 1);
});

test('allows an unknown laboratory only when live capabilities prove tools and forced choice', async () => {
  const transport = fakeTransport({
    responses: [
      modelCatalog('acme/model', ['tools', 'tool_choice']),
      response({
        choices: [
          {
            finish_reason: 'tool_calls',
            message: {
              content: '',
              tool_calls: [
                {
                  id: 'call_1',
                  function: { name: 'lookup', arguments: '{}' },
                },
              ],
            },
          },
        ],
      }),
    ],
  });
  const provider = createUnifiedProvider({ transport, apiKey: 'key' });

  const finish = await provider.complete({
    model: 'acme/model',
    messages: [{ role: 'user', content: 'Look it up.' }],
    tools: [
      { name: 'lookup', inputSchema: { type: 'object' }, outputSchema: {} },
    ],
    toolChoice: { name: 'lookup' },
  });

  assert.equal(finish.toolCalls[0]?.name, 'lookup');
});

test('uses the upstream profile when an OpenAI-compatible proxy replaces the model id', async () => {
  const transport = fakeTransport({
    responses: [
      response({
        choices: [{ finish_reason: 'stop', message: { content: 'done' } }],
      }),
    ],
  });
  const provider = createUnifiedProvider({
    transport,
    apiKey: 'key',
    upstreamModel: 'openai/gpt-5.6-luna',
  });

  await provider.complete({
    model: 'benchflow-openrouter-openai-gpt-5.6-luna',
    messages: [{ role: 'user', content: 'Use a tool if needed.' }],
    tools: [
      { name: 'lookup', inputSchema: { type: 'object' }, outputSchema: {} },
    ],
  });
  const body = JSON.parse(transport.requests[0]?.body ?? '{}') as {
    readonly model?: string;
    readonly provider?: unknown;
  };

  assert.equal(transport.requests.length, 1);
  assert.match(transport.requests[0]?.url ?? '', /chat\/completions$/u);
  assert.equal(body.model, 'benchflow-openrouter-openai-gpt-5.6-luna');
  assert.deepEqual(body.provider, { require_parameters: true });
});

test('rejects a blank upstream model before provider activity', () => {
  assert.throws(
    () =>
      createUnifiedProvider({
        transport: fakeTransport({}),
        apiKey: 'key',
        upstreamModel: '  ',
      }),
    /upstreamModel must not be blank/u,
  );
});

test('emulates sequential tools when the model does not advertise parallel control', async () => {
  const transport = fakeTransport({
    responses: [
      modelCatalog('openai/gpt-5', ['tools']),
      response({
        choices: [
          {
            finish_reason: 'tool_calls',
            message: {
              content: '',
              tool_calls: [
                {
                  id: 'call_1',
                  function: { name: 'lookup', arguments: '{}' },
                },
              ],
            },
          },
        ],
      }),
    ],
  });
  const provider = createUnifiedProvider({ transport, apiKey: 'key' });

  await provider.complete({
    model: 'openai/gpt-5',
    messages: [{ role: 'user', content: 'Look it up.' }],
    tools: [
      { name: 'lookup', inputSchema: { type: 'object' }, outputSchema: {} },
    ],
    parallelToolCalls: false,
  });
  const body = JSON.parse(transport.requests[1]?.body ?? '{}') as {
    readonly messages?: readonly {
      readonly role?: string;
      readonly content?: string;
    }[];
    readonly parallel_tool_calls?: boolean;
    readonly provider?: unknown;
  };

  assert.equal(body.parallel_tool_calls, undefined);
  assert.deepEqual(body.provider, { require_parameters: true });
  assert.match(
    body.messages?.find(({ role }) => role === 'system')?.content ?? '',
    /limit applies only to the current response, not to the task or node/u,
  );
});

test('forwards parallel tool control when the model advertises it', async () => {
  const transport = fakeTransport({
    responses: [
      modelCatalog('z-ai/glm-5', ['tools', 'parallel_tool_calls']),
      response({
        choices: [{ finish_reason: 'stop', message: { content: 'done' } }],
      }),
    ],
  });
  const provider = createUnifiedProvider({ transport, apiKey: 'key' });

  await provider.complete({
    model: 'z-ai/glm-5',
    messages: [{ role: 'user', content: 'Use a tool if needed.' }],
    tools: [
      { name: 'lookup', inputSchema: { type: 'object' }, outputSchema: {} },
    ],
    parallelToolCalls: false,
  });
  const body = JSON.parse(transport.requests[1]?.body ?? '{}') as {
    readonly parallel_tool_calls?: boolean;
  };

  assert.equal(body.parallel_tool_calls, false);
});

test('rejects native schema and tools in the same unified request', async () => {
  const provider = createUnifiedProvider({
    transport: fakeTransport({}),
    apiKey: 'key',
  });

  await assert.rejects(
    provider.complete({
      model: 'openai/gpt-5',
      messages: [{ role: 'user', content: 'Answer.' }],
      tools: [
        { name: 'lookup', inputSchema: { type: 'object' }, outputSchema: {} },
      ],
      schema: z.object({ answer: z.string() }),
    }),
    (error: unknown) =>
      error instanceof ProviderErrorObject &&
      error.data.code === 'unsupported_structured_tools',
  );
});
