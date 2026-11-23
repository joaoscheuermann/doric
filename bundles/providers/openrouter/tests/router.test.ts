// `openrouter`'s `models.provider/v1` 1.4.0 through the router (spec
// `docs/designs/grpc-processes.md`, "Model providers"; phase 3, slice S43):
// `kindSource(openRouterKind, …)` served by `llms/rpc`'s `serveProviderKind` on
// `createTestRouter`, as `src/host/main.ts` serves it, over a fake HTTP
// transport.

import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';

import { ProviderService } from 'bundle/contracts/gen/doric/models/provider/v1/provider_pb.js';
import { createTestRouter } from 'bundle/testing';
import {
  type HttpRequest,
  type HttpStreamChunk,
  type HttpTransport,
  providerKind,
} from 'llms';
import { serveProviderKind } from 'llms/rpc';
import pino from 'pino';

import { openRouterKind } from '../src/host/kind.js';
import { kindSource } from '../src/host/provider.js';
import { frozenKind } from './support/world.js';

/**
 * A transport that keeps every request: `request` answers the JSON `answer`
 * gives for it (status 200 unless it says otherwise), `stream` the chunks of
 * `stream`.
 */
const routedTransport = (options: {
  readonly answer?: (request: HttpRequest) => {
    readonly status?: number;
    readonly body: unknown;
  };
  readonly stream?: readonly HttpStreamChunk[];
}) => {
  const requests: HttpRequest[] = [];
  const transport: HttpTransport = {
    request: (request) => {
      requests.push(request);

      const answer = options.answer?.(request) ?? { body: {} };

      return Promise.resolve({
        status: answer.status ?? 200,
        headers: {},
        body: JSON.stringify(answer.body),
      });
    },
    async *stream(request) {
      requests.push(request);

      for (const chunk of options.stream ?? []) {
        yield chunk;
      }
    },
  };

  return { requests, transport };
};

/**
 * A message or value as JSON carries it, without `$typeName`, absent members
 * or empty lists, so a descriptor compares with the kind it was made from.
 */
const plain = (value: unknown): unknown =>
  JSON.parse(JSON.stringify(value), (key, member: unknown) =>
    key === '$typeName' || (Array.isArray(member) && member.length === 0)
      ? undefined
      : member,
  ) as unknown;

/** `openrouter`'s `models.provider/v1` over `transport`, on a fresh test router. */
const serve = async (t: TestContext, transport: HttpTransport) => {
  const router = createTestRouter();

  t.after(() => router.control.stop());

  await router.activate({
    services: [
      [
        ProviderService,
        serveProviderKind(
          kindSource(openRouterKind, {
            transport: () => transport,
            logger: () => pino({ enabled: false }),
          }),
          {
            readAttachment: () => {
              throw new Error('No attachment in these tests.');
            },
          },
        ),
      ],
    ],
    activate: () => {},
  });

  return router.client(ProviderService);
};

/** A `Complete` call's items: the header, then one user message. */
async function* completion(
  target: {
    readonly providerId: string;
    readonly values: Readonly<Record<string, string>>;
    readonly secret?: string;
  },
  model: string,
) {
  yield {
    item: {
      case: 'header' as const,
      value: { target, options: { model } },
    },
  };
  yield {
    item: {
      case: 'message' as const,
      value: { role: 'user', content: { case: 'text' as const, value: 'Hi' } },
    },
  };
}

void test('Kind answers the frozen openrouter kind through the router', async (t) => {
  const client = await serve(t, routedTransport({}).transport);

  const { modelKindDescriptor } = await client.kind({});

  assert.ok(modelKindDescriptor !== undefined);
  assert.deepEqual(
    plain(modelKindDescriptor),
    plain({
      ...frozenKind(),
      lists: [...(providerKind('openrouter')?.lists ?? [])],
    }),
  );
});

const catalogBody = {
  data: [
    {
      id: 'openai/gpt-5',
      name: 'GPT-5',
      context_length: 200000,
      supported_parameters: [],
    },
  ],
};

void test('Models sends one request to the target’s endpoint with the secret as a bearer token', async (t) => {
  const { requests, transport } = routedTransport({
    answer: () => ({ body: catalogBody }),
  });
  const client = await serve(t, transport);

  const { models } = await client.models({
    target: {
      providerId: 'or',
      values: { endpoint: 'https://or.test/api/v1' },
      secret: 'tok',
    },
  });

  assert.equal(requests.length, 1);
  assert.equal(requests[0]?.url, 'https://or.test/api/v1/models');
  assert.equal(requests[0]?.headers?.authorization, 'Bearer tok');
  assert.deepEqual(
    models.map((model) => model.id),
    ['openai/gpt-5'],
  );
});

void test('Complete answers the parsed chat completion', async (t) => {
  const { transport } = routedTransport({
    answer: (request) =>
      request.url.endsWith('/models')
        ? { body: catalogBody }
        : {
            body: {
              choices: [
                { finish_reason: 'stop', message: { content: 'Hi there' } },
              ],
            },
          },
  });
  const client = await serve(t, transport);

  const { providerFinished } = await client.complete(
    completion({ providerId: 'or', values: {}, secret: 'tok' }, 'openai/gpt-5'),
  );

  assert.equal(providerFinished?.text, 'Hi there');
  assert.equal(providerFinished?.finishReason, 'stop');
});

void test('Catalog reads the endpoint’s models with the secret as a bearer token', async (t) => {
  const { requests, transport } = routedTransport({
    answer: () => ({ body: catalogBody }),
  });
  const client = await serve(t, transport);

  const { catalogResult } = await client.catalog({
    configuration: { endpoint: 'https://or.test/api/v1' },
    secret: 'tok',
  });

  assert.equal(catalogResult?.status, 'read');
  assert.deepEqual(
    catalogResult?.models.map((model) => model.id),
    ['openai/gpt-5'],
  );
  assert.equal(requests[0]?.url, 'https://or.test/api/v1/models');
  assert.equal(requests[0]?.headers?.authorization, 'Bearer tok');
});

void test('Catalog of an endpoint that fails is failed', async (t) => {
  const { transport } = routedTransport({
    answer: () => ({ status: 500, body: { error: 'down' } }),
  });
  const client = await serve(t, transport);

  const { catalogResult } = await client.catalog({
    configuration: {},
    secret: 'tok',
  });

  assert.equal(catalogResult?.status, 'failed');
});
