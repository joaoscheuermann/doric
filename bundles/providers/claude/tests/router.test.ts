// `claude`'s `models.provider/v1` 1.4.0 through the router (spec
// `docs/designs/grpc-processes.md`, "Model providers"; phase 3, slice S43):
// `kindSource(claudeKind, …)` served by `llms/rpc`'s `serveProviderKind` on
// `createTestRouter`, as `src/host/main.ts` serves it, over a fake HTTP
// transport.

import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';

import { fromConnectError } from 'bundle/contracts';
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

import { claudeKind } from '../src/host/kind.js';
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

/** `claude`'s `models.provider/v1` over `transport`, on a fresh test router. */
const serve = async (t: TestContext, transport: HttpTransport) => {
  const router = createTestRouter();

  t.after(() => router.control.stop());

  await router.activate({
    services: [
      [
        ProviderService,
        serveProviderKind(
          kindSource(claudeKind, {
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

/**
 * Asserts `promise` failed with a ConnectError of the Doric code `code`, and
 * with a message `message` matches when given.
 */
const rejectsWithCode = async (
  promise: Promise<unknown>,
  code: string,
  message?: RegExp,
) => {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(
      error instanceof Error && 'findDetails' in error,
      `expected a ConnectError: ${String(error)}`,
    );
    assert.equal(
      fromConnectError(error as Parameters<typeof fromConnectError>[0]).code,
      code,
      error.message,
    );

    if (message !== undefined) {
      assert.match(error.message, message);
    }

    return true;
  });
};

void test('Kind answers the frozen claude kind through the router', async (t) => {
  const client = await serve(t, routedTransport({}).transport);

  const { modelKindDescriptor } = await client.kind({});

  assert.ok(modelKindDescriptor !== undefined);
  assert.deepEqual(
    plain(modelKindDescriptor),
    plain({
      ...frozenKind(),
      lists: [...(providerKind('claude')?.lists ?? [])],
    }),
  );
});

void test('Models sends one request to the target’s endpoint, authorized with the target’s secret', async (t) => {
  const { requests, transport } = routedTransport({
    answer: () => ({
      body: {
        data: [{ id: 'claude-sonnet-4-6', display_name: 'Claude Sonnet 4.6' }],
        has_more: false,
      },
    }),
  });
  const client = await serve(t, transport);

  const { models } = await client.models({
    target: {
      providerId: 'cl',
      values: { endpoint: 'https://claude.test' },
      secret: 'claude-tok',
    },
  });

  assert.equal(requests.length, 1);
  assert.match(requests[0]?.url ?? '', /^https:\/\/claude\.test\/v1\/models/);
  assert.equal(requests[0]?.headers?.authorization, 'Bearer claude-tok');
  assert.deepEqual(
    models.map((model) => model.id),
    ['claude-sonnet-4-6'],
  );
});

void test('Complete answers the parsed Anthropic message', async (t) => {
  const { transport } = routedTransport({
    answer: (request) =>
      request.url.includes('/v1/models')
        ? { body: { data: [], has_more: false } }
        : {
            body: {
              id: 'msg_1',
              type: 'message',
              role: 'assistant',
              content: [{ type: 'text', text: 'Hello' }],
              model: 'claude-sonnet-4-5',
              stop_reason: 'end_turn',
              usage: { input_tokens: 3, output_tokens: 4 },
            },
          },
  });
  const client = await serve(t, transport);

  const { providerFinished } = await client.complete(
    completion(
      { providerId: 'cl', values: {}, secret: 'Bearer claude-login' },
      'claude-sonnet-4-5',
    ),
  );

  assert.equal(providerFinished?.text, 'Hello');
  assert.equal(providerFinished?.finishReason, 'stop');
});

void test('Catalog is absent without a login, and reads nothing', async (t) => {
  const { requests, transport } = routedTransport({});
  const client = await serve(t, transport);

  const { catalogResult } = await client.catalog({ configuration: {} });

  assert.equal(catalogResult?.status, 'absent');
  assert.equal(requests.length, 0);
});

void test('Catalog of a refused login is failed', async (t) => {
  const { transport } = routedTransport({
    answer: () => ({
      status: 401,
      body: {
        type: 'error',
        error: { type: 'authentication_error', message: 'invalid token' },
      },
    }),
  });
  const client = await serve(t, transport);

  const { catalogResult } = await client.catalog({
    configuration: {},
    secret: 'Bearer expired',
  });

  assert.equal(catalogResult?.status, 'failed');
});

void test('a target without its required token fails with invalid_input', async (t) => {
  const client = await serve(t, routedTransport({}).transport);

  await rejectsWithCode(
    client.models({ target: { providerId: 'cl', values: {} } }),
    'invalid_input',
  );
});

// Ported from the kernel suite `provider.test.ts` (S68a, X3): the behaviours
// no router case above covered.

void test('Advertised and CatalogCapacity answer that claude is listed and reports catalog capacity', async (t) => {
  const client = await serve(t, routedTransport({}).transport);

  assert.equal((await client.advertised({})).advertised, true);
  assert.equal((await client.catalogCapacity({})).catalogCapacity, true);
});

void test('Catalog is every model the login may call, with the efforts Anthropic lists for each', async (t) => {
  const effort = (...levels: string[]) => ({
    supported: levels.length > 0,
    ...Object.fromEntries(
      ['low', 'medium', 'high', 'xhigh', 'max'].map((level) => [
        level,
        { supported: levels.includes(level) },
      ]),
    ),
  });
  const { requests, transport } = routedTransport({
    answer: () => ({
      body: {
        data: [
          {
            id: 'claude-opus-5-5',
            display_name: 'Claude Opus 5.5',
            max_input_tokens: 1_000_000,
            capabilities: {
              effort: effort('low', 'medium', 'high', 'xhigh', 'max'),
            },
          },
          {
            id: 'claude-sonnet-4-6',
            display_name: 'Claude Sonnet 4.6',
            capabilities: { effort: effort('low', 'medium', 'high', 'max') },
          },
          {
            id: 'claude-haiku-4-5-20251001',
            display_name: 'Claude Haiku 4.5',
            capabilities: { effort: effort() },
          },
          // A listing without capabilities falls back to what the id says.
          { id: 'claude-sonnet-5-5', display_name: 'Claude Sonnet 5.5' },
        ],
        has_more: false,
      },
    }),
  });
  const client = await serve(t, transport);

  const { catalogResult } = await client.catalog({
    configuration: {},
    secret: 'Bearer claude-login',
  });

  assert.equal(requests.length, 1);
  assert.match(requests[0]?.url ?? '', /\/v1\/models\?/);
  assert.equal(requests[0]?.headers?.authorization, 'Bearer claude-login');
  assert.deepEqual(
    plain(catalogResult),
    plain({
      status: 'read',
      models: [
        {
          id: 'claude-opus-5-5',
          name: 'Claude Opus 5.5',
          reasonings: ['low', 'medium', 'high', 'xhigh', 'max'],
          parameters: [],
          defaultEffort: 'medium',
          mandatory: false,
        },
        {
          id: 'claude-sonnet-4-6',
          name: 'Claude Sonnet 4.6',
          reasonings: ['low', 'medium', 'high', 'max'],
          parameters: [],
          defaultEffort: 'high',
          mandatory: false,
        },
        {
          id: 'claude-haiku-4-5-20251001',
          name: 'Claude Haiku 4.5',
          reasonings: [],
          parameters: [],
          mandatory: false,
        },
        {
          id: 'claude-sonnet-5-5',
          name: 'Claude Sonnet 5.5',
          reasonings: ['low', 'medium', 'high', 'xhigh', 'max'],
          parameters: [],
          defaultEffort: 'high',
          mandatory: false,
        },
      ],
    }),
  );
});

void test('a target without a token, or with a blank one, fails with invalid_input naming the token', async (t) => {
  const client = await serve(t, routedTransport({}).transport);

  const blanks: Record<string, string>[] = [{}, { token: '   ' }];

  for (const values of blanks) {
    await rejectsWithCode(
      client.models({ target: { providerId: 'cl', values } }),
      'invalid_input',
      /Provider kind claude requires a token value\./,
    );
  }
});

void test('Icons choose Claude for the provider and every model', async (t) => {
  const client = await serve(t, routedTransport({}).transport);

  const { modelIconChoice } = await client.icons({
    configuration: {},
    models: ['a', 'b'],
  });

  assert.deepEqual(plain(modelIconChoice), {
    provider: 'claude',
    models: ['claude', 'claude'],
  });
});
