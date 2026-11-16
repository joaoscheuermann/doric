import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createClaudeProvider,
  createFetchTransport,
  type HttpTransport,
  type LlmProvider,
  ProviderErrorObject,
} from '../src/index.js';
import {
  createCodexProvider,
  createOpenAiProvider,
  createOpenRouterProvider,
  silentLogger,
} from './fakes.js';

void test('includes response diagnostics when opening a stream fails', async () => {
  const transport = createFetchTransport(async () => {
    return new Response('failed with Bearer secret-token-value', {
      status: 400,
    });
  });

  await assert.rejects(
    collect(transport.stream({ method: 'POST', url: 'https://example.test' })),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(Reflect.get(error, 'status'), 400);
      assert.equal(
        Reflect.get(error, 'diagnostic'),
        'failed with Bearer secret-token-value',
      );
      assert.doesNotMatch(error.message, /secret-token-value/u);
      return true;
    },
  );
});

const providers: readonly (readonly [
  string,
  (transport: HttpTransport) => LlmProvider,
])[] = [
  [
    'openai',
    (transport) => createOpenAiProvider({ transport, apiKey: 'test-token' }),
  ],
  [
    'openrouter',
    (transport) =>
      createOpenRouterProvider({ transport, apiKey: 'test-token' }),
  ],
  [
    'codex',
    (transport) =>
      createCodexProvider({ transport, authorization: 'Bearer test-token' }),
  ],
];

for (const [id, create] of providers) {
  for (const status of [401, 429, 500]) {
    void test(`preserves ${id} stream HTTP ${status} status and diagnostics`, async () => {
      const transport = createFetchTransport(
        async () =>
          new Response('failed with Bearer secret-token-value', { status }),
      );
      const provider = create(transport);

      await assert.rejects(
        collect(
          provider.stream({
            model: 'model',
            messages: [{ role: 'user', content: 'Hi' }],
          }),
        ),
        (error: unknown) => {
          assert.ok(error instanceof ProviderErrorObject);
          assert.equal(error.data.provider, id);
          assert.equal(error.data.status, status);
          assert.equal(
            error.data.code,
            status === 401 ? 'auth_failed' : 'http_error',
          );
          assert.equal(error.data.retryable, status !== 401);
          assert.equal(
            error.data.diagnostic,
            'failed with Bearer secret-token-value',
          );
          return true;
        },
      );
    });
  }

  void test(`preserves ${id} cancellation and arbitrary transport errors`, async () => {
    for (const failure of [
      new DOMException('cancelled', 'AbortError'),
      new TypeError('programming error'),
    ]) {
      const transport = createFetchTransport(async () => {
        throw failure;
      });
      const provider = create(transport);
      await assert.rejects(
        collect(
          provider.stream({
            model: 'model',
            messages: [{ role: 'user', content: 'Hi' }],
          }),
        ),
        (error: unknown) => error === failure,
      );
    }
  });
}

const request = {
  model: 'model',
  messages: [{ role: 'user' as const, content: 'Hi' }],
};

/** A Fetch that fails before any response, the way undici does. */
const failingFetch =
  (failure: unknown): typeof fetch =>
  async () => {
    throw failure;
  };

/** A Fetch whose 200 event-stream body breaks after its first bytes. */
const breakingBodyFetch =
  (failure: unknown): typeof fetch =>
  async () =>
    new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(': keep-alive\n\n'));
        },
        pull(controller) {
          controller.error(failure);
        },
      }),
      { status: 200, headers: { 'content-type': 'text/event-stream' } },
    );

const isNetworkError =
  (provider: string, failure: unknown) =>
  (error: unknown): boolean => {
    assert.ok(error instanceof ProviderErrorObject);
    assert.equal(error.data.code, 'network_error');
    assert.equal(error.data.retryable, true);
    assert.equal(error.data.provider, provider);
    assert.equal(error.message, `Could not connect to ${provider}.`);
    assert.equal(error.cause, failure);
    return true;
  };

const networkFailures: readonly (readonly [string, unknown])[] = [
  ...[
    'UND_ERR_CONNECT_TIMEOUT',
    'ECONNREFUSED',
    'ECONNRESET',
    'UND_ERR_SOCKET',
    'EAI_AGAIN',
  ].map(
    (code) =>
      [code, new TypeError('fetch failed', { cause: { code } })] as const,
  ),
  [
    'ECONNRESET two levels deep',
    new TypeError('fetch failed', {
      cause: new Error('socket hang up', { cause: { code: 'ECONNRESET' } }),
    }),
  ],
];

for (const [id, create] of providers) {
  for (const [name, failure] of networkFailures) {
    void test(`${id}: a connection failure (${name}) is a retryable network_error`, async () => {
      const provider = create(createFetchTransport(failingFetch(failure)));

      await assert.rejects(
        collect(provider.stream(request)),
        isNetworkError(id, failure),
      );
      await assert.rejects(
        provider.complete(request),
        isNetworkError(id, failure),
      );
    });
  }

  void test(`${id}: a connection dropped while the body streams is a network_error`, async () => {
    const failure = new TypeError('terminated', {
      cause: { code: 'UND_ERR_SOCKET' },
    });
    const provider = create(createFetchTransport(breakingBodyFetch(failure)));

    await assert.rejects(
      collect(provider.stream(request)),
      isNetworkError(id, failure),
    );
  });

  void test(`${id}: unresolvable hosts and causeless failures pass through unchanged`, async () => {
    for (const failure of [
      new TypeError('fetch failed', { cause: { code: 'ENOTFOUND' } }),
      new TypeError('fetch failed'),
    ]) {
      const provider = create(createFetchTransport(failingFetch(failure)));

      await assert.rejects(
        collect(provider.stream(request)),
        (error: unknown) => error === failure,
      );
      await assert.rejects(
        provider.complete(request),
        (error: unknown) => error === failure,
      );
    }
  });
}

void test('claude: a connect timeout is a retryable network_error', async () => {
  const failure = new TypeError('fetch failed', {
    cause: { code: 'UND_ERR_CONNECT_TIMEOUT' },
  });
  const provider = createClaudeProvider({
    transport: createFetchTransport(failingFetch(failure)),
    authorization: 'Bearer test-token',
    logger: silentLogger,
  });
  const id = provider.metadata.id;

  await assert.rejects(
    collect(provider.stream(request)),
    isNetworkError(id, failure),
  );
  await assert.rejects(provider.complete(request), isNetworkError(id, failure));
});

const collect = async <T>(items: AsyncIterable<T>): Promise<readonly T[]> => {
  const collected: T[] = [];

  for await (const item of items) {
    collected.push(item);
  }

  return collected;
};
