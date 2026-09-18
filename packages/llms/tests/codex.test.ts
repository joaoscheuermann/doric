import assert from 'node:assert/strict';
import test from 'node:test';

import { z } from 'zod';

import { ProviderErrorObject, type ProviderStreamEvent } from '../src/index.js';
import { collect, createCodexProvider, fakeTransport } from './fakes.js';

test('sends Codex ChatGPT account headers to the Codex backend', async () => {
  const transport = fakeTransport({
    streams: [
      [
        sse({
          type: 'response.completed',
          response: {
            status: 'completed',
            output_text: 'ok',
            output: [],
          },
        }),
        'data: [DONE]\n\n',
      ],
    ],
  });

  const provider = createCodexProvider({
    transport,
    authorization: 'Bearer codex-token',
    chatGptAccountId: 'acct_123',
    fedramp: true,
  });

  const result = await provider.complete({
    model: 'gpt-5.5',
    messages: [{ role: 'user', content: 'Hi' }],
    effort: 'high',
    temperature: 0,
  });
  const body = JSON.parse(transport.requests[0]?.body ?? '{}');

  assert.equal(provider.metadata.id, 'codex');

  assert.equal(
    transport.requests[0]?.url,
    'https://chatgpt.com/backend-api/codex/responses',
  );

  assert.equal(result.text, 'ok');

  assert.equal(body.model, 'gpt-5.5');

  assert.equal(body.stream, true);

  assert.equal(body.store, false);

  assert.deepEqual(body.reasoning, { effort: 'high' });

  assert.equal(body.temperature, undefined);

  assert.equal(body.instructions, 'You are Codex, a coding agent.');

  assert.equal(
    transport.requests[0]?.headers?.authorization,
    'Bearer codex-token',
  );

  assert.equal(
    transport.requests[0]?.headers?.['ChatGPT-Account-ID'],
    'acct_123',
  );

  assert.equal(transport.requests[0]?.headers?.['X-OpenAI-Fedramp'], 'true');
});

test('allows overriding the Codex backend base URL', async () => {
  const transport = fakeTransport({
    streams: [
      [
        sse({
          type: 'response.completed',
          response: {
            status: 'completed',
            output_text: 'ok',
            output: [],
          },
        }),
        'data: [DONE]\n\n',
      ],
    ],
  });

  const provider = createCodexProvider({
    transport,
    authorization: 'Bearer codex-token',
    baseUrl: 'https://codex.example.test/backend',
  });

  await provider.complete({
    model: 'gpt-5.5',
    messages: [{ role: 'user', content: 'Hi' }],
  });

  assert.equal(
    transport.requests[0]?.url,
    'https://codex.example.test/backend/responses',
  );
});

test('preserves caller-provided Codex instructions', async () => {
  const transport = fakeTransport({
    streams: [
      [
        sse({
          type: 'response.completed',
          response: {
            status: 'completed',
            output_text: 'ok',
            output: [],
          },
        }),
        'data: [DONE]\n\n',
      ],
    ],
  });

  const provider = createCodexProvider({
    transport,
    authorization: 'Bearer codex-token',
  });

  await provider.complete({
    model: 'gpt-5.5',
    messages: [
      { role: 'system', content: 'Use the repository conventions.' },
      { role: 'user', content: 'Hi' },
    ],
  });

  assert.equal(
    JSON.parse(transport.requests[0]?.body ?? '{}').instructions,
    'Use the repository conventions.',
  );
});

test('adds a schema instruction to Codex requests while retaining text format', async () => {
  const transport = fakeTransport({
    streams: [
      [
        sse({
          type: 'response.completed',
          response: {
            status: 'completed',
            output_text: '{"answer":"Done"}',
            output: [],
          },
        }),
        'data: [DONE]\n\n',
      ],
    ],
  });

  const provider = createCodexProvider({
    transport,
    authorization: 'Bearer codex-token',
  });

  await provider.complete({
    model: 'gpt-5.5',
    messages: [
      { role: 'system', content: 'Follow policy.' },
      { role: 'user', content: 'Return JSON.' },
    ],
    schema: z.object({ answer: z.string() }),
    flags: { includeStructuredSchemaOnSystemPrompt: true },
  });

  const body = JSON.parse(transport.requests[0]?.body ?? '{}');

  assert.match(
    body.instructions,
    /^Follow policy\.[\s\S]*Return exactly one JSON object[\s\S]*JSON Schema/u,
  );

  assert.equal(body.text.format.type, 'json_schema');

  assert.deepEqual(body.input, [
    {
      role: 'user',
      content: [{ type: 'input_text', text: 'Return JSON.' }],
    },
  ]);
});

test('rejects Codex complete when the stream emits a provider error', async () => {
  const transport = fakeTransport({
    streams: [['data: not-json\n\n']],
  });

  const provider = createCodexProvider({
    transport,
    authorization: 'Bearer codex-token',
  });

  await assert.rejects(
    provider.complete({
      model: 'gpt-5.5',
      messages: [{ role: 'user', content: 'Hi' }],
    }),
    (error) =>
      error instanceof ProviderErrorObject &&
      error.data.provider === 'codex' &&
      error.data.code === 'malformed_stream_event',
  );
});

test('rejects Codex complete refusals when structured output is required', async () => {
  const transport = fakeTransport({
    streams: [
      [
        sse({ type: 'response.refusal.delta', delta: 'No.' }),
        sse({
          type: 'response.completed',
          response: { status: 'completed' },
        }),
        'data: [DONE]\n\n',
      ],
    ],
  });

  const provider = createCodexProvider({
    transport,
    authorization: 'Bearer codex-token',
  });

  await assert.rejects(
    provider.complete({
      model: 'gpt-5.5',
      messages: [{ role: 'user', content: 'Hi' }],
      schema: z.object({ answer: z.string() }),
    }),
    (error: unknown) =>
      error instanceof ProviderErrorObject &&
      error.data.provider === 'codex' &&
      error.data.code === 'invalid_structured_output',
  );
});

test('maps Codex stream provider identity', async () => {
  const transport = fakeTransport({
    streams: [
      [
        sse({
          type: 'response.completed',
          response: {
            status: 'completed',
            output_text: 'ok',
            output: [],
          },
        }),
        'data: [DONE]\n\n',
      ],
    ],
  });

  const provider = createCodexProvider({
    transport,
    authorization: 'Bearer codex-token',
  });

  const events = await collect(
    provider.stream({
      model: 'gpt-5.5',
      messages: [{ role: 'user', content: 'Hi' }],
    }),
  );

  assert.deepEqual(events[0], {
    type: 'response.started',
    provider: 'codex',
    model: 'gpt-5.5',
  } satisfies ProviderStreamEvent);

  const body = JSON.parse(transport.requests[0]?.body ?? '{}');

  assert.equal(body.store, false);

  assert.equal(body.instructions, 'You are Codex, a coding agent.');
});

const sse = (payload: unknown): string =>
  `data: ${JSON.stringify(payload)}\n\n`;
