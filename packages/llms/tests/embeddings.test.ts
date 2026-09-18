import assert from 'node:assert/strict';
import test from 'node:test';

import { ProviderErrorObject, type LlmProvider } from '../src/index.js';
import {
  createCodexProvider,
  createLmStudioOpenAiProvider,
  createLmStudioProvider,
  createOpenAiProvider,
  createOpenRouterProvider,
  fakeTransport,
  response,
} from './fakes.js';

type CompatibleProvider = {
  readonly name: string;
  readonly provider: LlmProvider;
  readonly transport: ReturnType<typeof fakeTransport>;
  readonly endpoint: string;
  readonly authorization?: string;
};

const compatibleProviders = (): readonly CompatibleProvider[] => {
  const openAiTransport = fakeTransport({
    responses: [response({ data: [{ embedding: [0.25, -0.5] }] })],
  });
  const lmStudioTransport = fakeTransport({
    responses: [response({ data: [{ embedding: [0.25, -0.5] }] })],
  });
  const openRouterTransport = fakeTransport({
    responses: [response({ data: [{ embedding: [0.25, -0.5] }] })],
  });

  return [
    {
      name: 'OpenAI',
      provider: createOpenAiProvider({
        transport: openAiTransport,
        apiKey: 'openai-key',
      }),
      transport: openAiTransport,
      endpoint: 'https://api.openai.com/v1/embeddings',
      authorization: 'Bearer openai-key',
    },
    {
      name: 'LM Studio OpenAI compatibility',
      provider: createLmStudioOpenAiProvider({
        transport: lmStudioTransport,
        apiKey: 'local-key',
      }),
      transport: lmStudioTransport,
      endpoint: 'http://localhost:1234/v1/embeddings',
      authorization: 'Bearer local-key',
    },
    {
      name: 'OpenRouter',
      provider: createOpenRouterProvider({
        transport: openRouterTransport,
        apiKey: 'router-key',
      }),
      transport: openRouterTransport,
      endpoint: 'https://openrouter.ai/api/v1/embeddings',
      authorization: 'Bearer router-key',
    },
  ];
};

for (const fixture of compatibleProviders()) {
  test(`creates embeddings through ${fixture.name}`, async () => {
    const controller = new AbortController();

    const result = await fixture.provider.embedding({
      model: 'text-embedding-3-small',
      input: 'A short document.',
      dimensions: 1024,
      signal: controller.signal,
      flags: { sensitiveOutput: true },
    });
    const request = fixture.transport.requests[0];

    assert.equal(fixture.provider.capabilities.embeddings, true);
    assert.deepEqual(result, { embedding: [0.25, -0.5] });
    assert.equal(request?.method, 'POST');
    assert.equal(request?.url, fixture.endpoint);
    assert.equal(request?.headers?.authorization, fixture.authorization);
    assert.equal(request?.headers?.['content-type'], 'application/json');
    assert.equal(request?.headers?.accept, 'application/json');
    assert.deepEqual(JSON.parse(request?.body ?? '{}'), {
      model: 'text-embedding-3-small',
      input: 'A short document.',
      dimensions: 1024,
    });
    assert.equal(request?.signal, controller.signal);
  });
}

test('preserves OpenRouter embedding usage and cost', async () => {
  const transport = fakeTransport({
    responses: [
      response({
        data: [{ embedding: [0.25, -0.5] }],
        usage: {
          prompt_tokens: 7,
          total_tokens: 7,
          cost: 0.000_004,
          cost_details: { upstream_inference_cost: 0.000_003 },
        },
      }),
    ],
  });
  const provider = createOpenRouterProvider({
    transport,
    apiKey: 'router-key',
  });

  const result = await provider.embedding({
    model: 'text-embedding-3-small',
    input: 'A short document.',
  });

  assert.deepEqual(result.embedding, [0.25, -0.5]);
  assert.deepEqual(result.usage?.cost, {
    amount: 0.000_004,
    unit: 'credits',
    upstreamAmount: 0.000_003,
  });
  assert.equal(result.usage?.inputTokens, 7);
  assert.equal(result.usage?.totalTokens, 7);
});

test('rejects malformed OpenAI embedding responses', async () => {
  const transport = fakeTransport({
    responses: [
      response({ data: [] }),
      response({ data: [{ embedding: [] }] }),
      response({ data: [{ embedding: [0.1, Number.NaN] }] }),
    ],
  });
  const provider = createOpenAiProvider({ transport, apiKey: 'openai-key' });

  for (let index = 0; index < 3; index += 1) {
    await assert.rejects(
      provider.embedding({
        model: 'text-embedding-3-small',
        input: 'A short document.',
      }),
      (error: unknown) =>
        error instanceof ProviderErrorObject &&
        error.data.provider === 'openai' &&
        error.data.code === 'invalid_embedding',
    );
  }
});

test('rejects OpenAI embedding requests without a model or input before networking', async () => {
  const transport = fakeTransport({});
  const provider = createOpenAiProvider({ transport, apiKey: 'openai-key' });

  await assert.rejects(
    provider.embedding({ model: ' ', input: 'A short document.' }),
    (error: unknown) =>
      error instanceof ProviderErrorObject &&
      error.data.code === 'missing_model',
  );
  await assert.rejects(
    provider.embedding({ model: 'text-embedding-3-small', input: '' }),
    (error: unknown) =>
      error instanceof ProviderErrorObject &&
      error.data.code === 'missing_input',
  );
  assert.equal(transport.requests.length, 0);
});

test('rejects invalid embedding dimensions before networking', async () => {
  const transport = fakeTransport({});
  const provider = createOpenAiProvider({ transport, apiKey: 'openai-key' });

  for (const dimensions of [0, 1.5, Number.NaN]) {
    await assert.rejects(
      provider.embedding({
        model: 'text-embedding-3-small',
        input: 'A short document.',
        dimensions,
      }),
      (error: unknown) =>
        error instanceof ProviderErrorObject &&
        error.data.code === 'invalid_dimensions',
    );
  }

  assert.equal(transport.requests.length, 0);
});

for (const fixture of [
  {
    name: 'LM Studio native',
    transport: fakeTransport({}),
  },
  {
    name: 'Codex',
    transport: fakeTransport({}),
  },
]) {
  const provider =
    fixture.name === 'Codex'
      ? createCodexProvider({
          transport: fixture.transport,
          authorization: 'Bearer codex-token',
        })
      : createLmStudioProvider({ transport: fixture.transport });

  test(`rejects embeddings before networking through ${fixture.name}`, async () => {
    await assert.rejects(
      provider.embedding({
        model: 'text-embedding-3-small',
        input: 'A short document.',
      }),
      (error: unknown) =>
        error instanceof ProviderErrorObject &&
        error.data.code === 'unsupported_embeddings',
    );

    assert.equal(provider.capabilities.embeddings, false);
    assert.equal(fixture.transport.requests.length, 0);
  });
}
