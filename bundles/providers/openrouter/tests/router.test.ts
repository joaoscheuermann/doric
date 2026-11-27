// `openrouter`'s `models.provider/v1` 1.4.0 through the router (spec
// `docs/designs/grpc-processes.md`, "Model providers"; phase 3, slice S43):
// `kindSource(openRouterKind, …)` served by `llms/rpc`'s `serveProviderKind` on
// `createTestRouter`, as `src/host/main.ts` serves it, over a fake HTTP
// transport.

import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';

import { fromConnectError, type Log, type LogFields } from 'bundle/contracts';
import { ProviderService } from 'bundle/contracts/gen/doric/models/provider/v1/provider_pb.js';
import { createTestRouter } from 'bundle/testing';
import {
  type HttpRequest,
  type HttpStreamChunk,
  type HttpTransport,
  providerKind,
} from 'llms';
import { serveProviderKind } from 'llms/rpc';
import pino, { type Logger } from 'pino';

import { openRouterKind } from '../src/host/kind.js';
import { logV1Logger } from '../src/host/logger.js';
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

/** One log/v1 line. */
interface Line {
  readonly level: string;
  readonly message: string;
  readonly fields?: LogFields;
}

/** The llms logger as `main.ts` builds it, over a log/v1 that keeps every line. */
const loggedLines = () => {
  const lines: Line[] = [];
  const level =
    (name: string) =>
    (message: string, fields?: LogFields): void => {
      lines.push({
        level: name,
        message,
        ...(fields === undefined ? {} : { fields }),
      });
    };
  const log: Log = {
    debug: level('debug'),
    info: level('info'),
    warn: level('warn'),
    error: level('error'),
  };

  return { lines, logger: logV1Logger(log) };
};

/** Asserts `promise` failed with a ConnectError of the Doric code `code` and a message `message` matches. */
const rejectsWithCode = async (
  promise: Promise<unknown>,
  code: string,
  message: RegExp,
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
    assert.match(error.message, message);

    return true;
  });
};

/**
 * `openrouter`'s `models.provider/v1` over `transport`, on a fresh test
 * router; the llms logger is silent unless `logger` is given.
 */
const serve = async (
  t: TestContext,
  transport: HttpTransport,
  logger: Logger = pino({ enabled: false }),
) => {
  const router = createTestRouter();

  t.after(() => router.control.stop());

  await router.activate({
    services: [
      [
        ProviderService,
        serveProviderKind(
          kindSource(openRouterKind, {
            transport: () => transport,
            logger: () => logger,
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

// Ported from the kernel suites `provider.test.ts` and `catalog.test.ts`
// (S68a, X3): the behaviours no router case above covered.

void test('Advertised and CatalogCapacity answer that openrouter is listed and reports catalog capacity', async (t) => {
  const client = await serve(t, routedTransport({}).transport);

  assert.equal((await client.advertised({})).advertised, true);
  assert.equal((await client.catalogCapacity({})).catalogCapacity, true);
});

void test('a missing token or a repair count that is not a number fails with invalid_input, and a number builds', async (t) => {
  const { requests, transport } = routedTransport({
    answer: () => ({ body: catalogBody }),
  });
  const client = await serve(t, transport);

  await rejectsWithCode(
    client.models({ target: { providerId: 'or', values: {} } }),
    'invalid_input',
    /Provider kind openrouter requires a token value\./,
  );
  await rejectsWithCode(
    client.models({
      target: {
        providerId: 'or',
        values: { maxStructuredOutputRepairs: 'many' },
        secret: 'sk',
      },
    }),
    'invalid_input',
    /Provider value maxStructuredOutputRepairs is not a number: many/,
  );
  assert.equal(requests.length, 0);

  const { models } = await client.models({
    target: {
      providerId: 'or',
      values: { maxStructuredOutputRepairs: '3' },
      secret: 'sk',
    },
  });

  assert.deepEqual(
    models.map((model) => model.id),
    ['openai/gpt-5'],
  );
});

void test("Icons choose OpenRouter as the provider's own icon and each model's lab", async (t) => {
  const client = await serve(t, routedTransport({}).transport);

  const { modelIconChoice } = await client.icons({
    configuration: {},
    models: ['anthropic/claude-sonnet-4', 'acme/coder-7b'],
  });

  // The wire writes a model without an icon as "".
  assert.deepEqual(plain(modelIconChoice), {
    provider: 'openrouter',
    models: ['claude', ''],
  });
});

void test('Catalog reads the default models URL with the secret as a bearer token', async (t) => {
  const { requests, transport } = routedTransport({
    answer: () => ({
      body: { data: [{ id: 'openai/gpt-5', context_length: 400000 }] },
    }),
  });
  const client = await serve(t, transport);

  const { catalogResult } = await client.catalog({
    configuration: {},
    secret: 'sk-or',
  });

  assert.equal(catalogResult?.status, 'read');
  assert.deepEqual(
    catalogResult?.models.map((model) => model.id),
    ['openai/gpt-5'],
  );
  assert.deepEqual(requests, [
    {
      method: 'GET',
      url: 'https://openrouter.ai/api/v1/models',
      headers: { accept: 'application/json', authorization: 'Bearer sk-or' },
    },
  ]);
});

void test('a Catalog with an empty or missing secret sends no authorization header', async (t) => {
  const { requests, transport } = routedTransport({
    answer: () => ({ body: catalogBody }),
  });
  const client = await serve(t, transport);

  await client.catalog({ configuration: {}, secret: '' });
  await client.catalog({ configuration: {} });

  assert.deepEqual(
    requests.map(({ headers }) => headers),
    [{ accept: 'application/json' }, { accept: 'application/json' }],
  );
});

void test('the Catalog URL is the models URL, else the endpoint models path', async (t) => {
  const { requests, transport } = routedTransport({
    answer: () => ({ body: catalogBody }),
  });
  const client = await serve(t, transport);

  await client.catalog({
    configuration: { endpoint: 'https://proxy.test/v1' },
  });
  await client.catalog({
    configuration: {
      endpoint: 'https://proxy.test/v1',
      modelsUrl: 'https://catalog.test/list',
    },
  });

  assert.deepEqual(
    requests.map(({ url }) => url),
    ['https://proxy.test/v1/models', 'https://catalog.test/list'],
  );
});

void test('a Catalog that cannot be read is failed and logs nothing naming the URL or secret', async (t) => {
  const transport: HttpTransport = {
    request: () => Promise.reject(new Error('connection refused')),
    stream: () => {
      throw new Error('No stream in these tests.');
    },
  };
  const { lines, logger } = loggedLines();
  const client = await serve(t, transport, logger);

  const { catalogResult } = await client.catalog({
    configuration: { modelsUrl: 'https://catalog.test/list' },
    secret: 'sk-secret',
  });

  assert.equal(catalogResult?.status, 'failed');

  const logged = JSON.stringify(lines);

  assert.equal(logged.includes('catalog.test'), false);
  assert.equal(logged.includes('sk-secret'), false);
});
