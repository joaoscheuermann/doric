import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createFetchTransport,
  ProviderErrorObject,
  type HttpTransport,
  type LlmProvider,
} from '../src/index.js';
import {
  createOpenAiProvider,
  createOpenRouterProvider,
  createLmStudioProvider,
  createLmStudioOpenAiProvider,
  createCodexProvider,
} from './fakes.js';

test('includes response diagnostics when opening a stream fails', async () => {
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
  ['lmstudio', (transport) => createLmStudioProvider({ transport })],
  [
    'lmstudio-openai',
    (transport) => createLmStudioOpenAiProvider({ transport }),
  ],
  [
    'codex',
    (transport) =>
      createCodexProvider({ transport, authorization: 'Bearer test-token' }),
  ],
];

for (const [id, create] of providers) {
  for (const status of [401, 429, 500]) {
    test(`preserves ${id} stream HTTP ${status} status and diagnostics`, async () => {
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

  test(`preserves ${id} cancellation and arbitrary transport errors`, async () => {
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

const collect = async <T>(items: AsyncIterable<T>): Promise<readonly T[]> => {
  const collected: T[] = [];

  for await (const item of items) {
    collected.push(item);
  }

  return collected;
};
