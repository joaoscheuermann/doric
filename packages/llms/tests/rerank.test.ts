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
  const body = {
    id: 'rerank-1',
    model: 'rerank-model',
    results: [
      { index: 1, relevance_score: 0.91 },
      { index: 0, relevance_score: 0.42 },
    ],
  };
  const openAiTransport = fakeTransport({ responses: [response(body)] });
  const lmStudioTransport = fakeTransport({ responses: [response(body)] });
  const openRouterTransport = fakeTransport({ responses: [response(body)] });

  return [
    {
      name: 'OpenAI',
      provider: createOpenAiProvider({
        transport: openAiTransport,
        apiKey: 'openai-key',
      }),
      transport: openAiTransport,
      endpoint: 'https://api.openai.com/v1/rerank',
      authorization: 'Bearer openai-key',
    },
    {
      name: 'LM Studio OpenAI compatibility',
      provider: createLmStudioOpenAiProvider({
        transport: lmStudioTransport,
        apiKey: 'local-key',
      }),
      transport: lmStudioTransport,
      endpoint: 'http://localhost:1234/v1/rerank',
      authorization: 'Bearer local-key',
    },
    {
      name: 'OpenRouter',
      provider: createOpenRouterProvider({
        transport: openRouterTransport,
        apiKey: 'router-key',
      }),
      transport: openRouterTransport,
      endpoint: 'https://openrouter.ai/api/v1/rerank',
      authorization: 'Bearer router-key',
    },
  ];
};

for (const fixture of compatibleProviders()) {
  test(`reranks documents through ${fixture.name}`, async () => {
    const controller = new AbortController();

    const result = await fixture.provider.rerank({
      model: 'rerank-model',
      query: 'capital of France',
      documents: ['Berlin is in Germany.', 'Paris is in France.'],
      topN: 2,
      signal: controller.signal,
      flags: { sensitiveOutput: true },
    });
    const request = fixture.transport.requests[0];

    assert.equal(fixture.provider.capabilities.reranking, true);
    assert.deepEqual(result, {
      results: [
        { index: 1, relevanceScore: 0.91 },
        { index: 0, relevanceScore: 0.42 },
      ],
    });
    assert.equal(request?.method, 'POST');
    assert.equal(request?.url, fixture.endpoint);
    assert.equal(request?.headers?.authorization, fixture.authorization);
    assert.equal(request?.headers?.['content-type'], 'application/json');
    assert.equal(request?.headers?.accept, 'application/json');
    assert.deepEqual(JSON.parse(request?.body ?? '{}'), {
      model: 'rerank-model',
      query: 'capital of France',
      documents: ['Berlin is in Germany.', 'Paris is in France.'],
      top_n: 2,
    });
    assert.equal(request?.signal, controller.signal);
  });
}

test('preserves OpenRouter rerank usage and cost', async () => {
  const transport = fakeTransport({
    responses: [
      response({
        id: 'rerank-1',
        model: 'rerank-model',
        results: [{ index: 0, relevance_score: 0.91 }],
        usage: {
          search_units: 1,
          total_tokens: 150,
          cost: 0.000_02,
          cost_details: { upstream_inference_cost: 0.000_015 },
        },
      }),
    ],
  });
  const provider = createOpenRouterProvider({
    transport,
    apiKey: 'router-key',
  });

  const result = await provider.rerank({
    model: 'rerank-model',
    query: 'capital of France',
    documents: ['Paris is in France.'],
  });

  assert.deepEqual(result.results, [{ index: 0, relevanceScore: 0.91 }]);
  assert.deepEqual(result.usage?.cost, {
    amount: 0.000_02,
    unit: 'credits',
    upstreamAmount: 0.000_015,
  });
  assert.equal(result.usage?.searchUnits, 1);
  assert.equal(result.usage?.totalTokens, 150);
});

test('rejects malformed rerank responses', async () => {
  const transport = fakeTransport({
    responses: [
      response({ results: [] }),
      response({ results: [{ index: -1, relevance_score: 0.5 }] }),
      response({ results: [{ index: 0, relevance_score: 'high' }] }),
    ],
  });
  const provider = createOpenRouterProvider({
    transport,
    apiKey: 'router-key',
  });

  for (let index = 0; index < 3; index += 1) {
    await assert.rejects(
      provider.rerank({
        model: 'rerank-model',
        query: 'query',
        documents: ['document'],
      }),
      (error: unknown) =>
        error instanceof ProviderErrorObject &&
        error.data.provider === 'openrouter' &&
        error.data.code === 'invalid_rerank',
    );
  }
});

test('rejects invalid rerank requests before networking', async () => {
  const transport = fakeTransport({});
  const provider = createOpenRouterProvider({
    transport,
    apiKey: 'router-key',
  });

  await assert.rejects(
    provider.rerank({ model: '', query: 'query', documents: ['document'] }),
    (error: unknown) =>
      error instanceof ProviderErrorObject &&
      error.data.code === 'missing_model',
  );
  await assert.rejects(
    provider.rerank({
      model: 'rerank-model',
      query: '',
      documents: ['document'],
    }),
    (error: unknown) =>
      error instanceof ProviderErrorObject &&
      error.data.code === 'missing_input',
  );
  await assert.rejects(
    provider.rerank({ model: 'rerank-model', query: 'query', documents: [] }),
    (error: unknown) =>
      error instanceof ProviderErrorObject &&
      error.data.code === 'missing_input',
  );
  await assert.rejects(
    provider.rerank({
      model: 'rerank-model',
      query: 'query',
      documents: ['document'],
      topN: 0,
    }),
    (error: unknown) =>
      error instanceof ProviderErrorObject &&
      error.data.code === 'invalid_top_n',
  );
  assert.equal(transport.requests.length, 0);
});

for (const fixture of [
  { name: 'LM Studio native', transport: fakeTransport({}) },
  { name: 'Codex', transport: fakeTransport({}) },
]) {
  const provider =
    fixture.name === 'Codex'
      ? createCodexProvider({
          transport: fixture.transport,
          authorization: 'Bearer codex-token',
        })
      : createLmStudioProvider({ transport: fixture.transport });

  test(`rejects reranking before networking through ${fixture.name}`, async () => {
    await assert.rejects(
      provider.rerank({
        model: 'rerank-model',
        query: 'query',
        documents: ['document'],
      }),
      (error: unknown) =>
        error instanceof ProviderErrorObject &&
        error.data.code === 'unsupported_reranking',
    );

    assert.equal(provider.capabilities.reranking, false);
    assert.equal(fixture.transport.requests.length, 0);
  });
}
