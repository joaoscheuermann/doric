// `openai`'s `models.provider/v1` 1.4.0 through the router (spec
// `docs/designs/grpc-processes.md`, "Model providers"; phase 3, slice S43):
// `kindSource(openAiKind, …)` served by `llms/rpc`'s `serveProviderKind` on
// `createTestRouter`, as `src/host/main.ts` serves it, over a fake HTTP
// transport.

import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';

import type { Log, LogFields } from 'bundle/contracts';
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

import { openAiKind } from '../src/host/kind.js';
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

/**
 * `openai`'s `models.provider/v1` over `transport`, on a fresh test router;
 * the llms logger is silent unless `logger` is given.
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
          kindSource(openAiKind, {
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

void test('Kind answers the frozen openai kind through the router', async (t) => {
  const client = await serve(t, routedTransport({}).transport);

  const { modelKindDescriptor } = await client.kind({});

  assert.ok(modelKindDescriptor !== undefined);
  assert.deepEqual(
    plain(modelKindDescriptor),
    plain({
      ...frozenKind(),
      lists: [...(providerKind('openai')?.lists ?? [])],
    }),
  );
});

void test('Models sends one request to the target’s endpoint with the secret as a bearer token', async (t) => {
  const { requests, transport } = routedTransport({
    answer: () => ({ body: { data: [{ id: 'gpt-5' }] } }),
  });
  const client = await serve(t, transport);

  const { models } = await client.models({
    target: {
      providerId: 'work',
      values: { endpoint: 'https://work.test/v1' },
      secret: 'tok',
    },
  });

  assert.equal(requests.length, 1);
  assert.equal(requests[0]?.url, 'https://work.test/v1/models');
  assert.equal(requests[0]?.headers?.authorization, 'Bearer tok');
  assert.deepEqual(
    models.map((model) => model.id),
    ['gpt-5'],
  );
});

void test('Complete answers the parsed Responses result', async (t) => {
  const { transport } = routedTransport({
    answer: (request) =>
      request.url.endsWith('/models')
        ? { body: { data: [{ id: 'gpt-5' }] } }
        : {
            body: {
              status: 'completed',
              output_text: 'Done',
              output: [],
              usage: { input_tokens: 3, output_tokens: 4, total_tokens: 7 },
            },
          },
  });
  const client = await serve(t, transport);

  const { providerFinished } = await client.complete(
    completion({ providerId: 'work', values: {}, secret: 'tok' }, 'gpt-5'),
  );

  assert.equal(providerFinished?.text, 'Done');
  assert.equal(providerFinished?.finishReason, 'stop');
});

void test('Catalog is absent, and reads nothing', async (t) => {
  const { requests, transport } = routedTransport({});
  const client = await serve(t, transport);

  const { catalogResult } = await client.catalog({
    configuration: { endpoint: 'https://work.test/v1' },
    secret: 'tok',
  });

  assert.equal(catalogResult?.status, 'absent');
  assert.equal(requests.length, 0);
});

// Ported from the kernel suite `provider.test.ts` (S68a, X3): the behaviours
// no router case above covered.

void test('Advertised and CatalogCapacity answer that openai is listed and reports no catalog capacity', async (t) => {
  const client = await serve(t, routedTransport({}).transport);

  assert.equal((await client.advertised({})).advertised, true);
  assert.equal((await client.catalogCapacity({})).catalogCapacity, false);
});

void test('a target without a secret logs its provider id as identity through log/v1 and sends no authorization', async (t) => {
  const { requests, transport } = routedTransport({
    answer: () => ({ body: { data: [{ id: 'gpt-5' }] } }),
  });
  const { lines, logger } = loggedLines();
  const client = await serve(t, transport, logger);

  await client.models({
    target: {
      providerId: 'work',
      values: { endpoint: 'https://work.test/v1' },
    },
  });

  assert.deepEqual(
    lines.find(({ message }) => message === 'llm provider initialized'),
    {
      level: 'debug',
      message: 'llm provider initialized',
      fields: { component: 'llms', provider: 'work' },
    },
  );
  assert.equal(requests.at(-1)?.url, 'https://work.test/v1/models');
  assert.equal(requests.at(-1)?.headers?.authorization, undefined);
});

void test('without an endpoint the provider uses the kind default base URL', async (t) => {
  const { requests, transport } = routedTransport({
    answer: () => ({ body: { data: [{ id: 'gpt-5' }] } }),
  });
  const client = await serve(t, transport);

  await client.models({
    target: { providerId: 'work', values: {}, secret: 'tok' },
  });

  assert.equal(
    requests.at(-1)?.url,
    `${frozenKind().fields[0]?.placeholder}/models`,
  );
});

void test('a rotated secret reaches the next request of the same provider', async (t) => {
  const { requests, transport } = routedTransport({
    answer: () => ({ body: { data: [{ id: 'gpt-5' }] } }),
  });
  const client = await serve(t, transport);
  const target = (secret: string) => ({
    providerId: 'work',
    values: { endpoint: 'https://work.test/v1' },
    secret,
  });

  await client.models({ target: target('first') });
  assert.equal(requests.at(-1)?.headers?.authorization, 'Bearer first');

  await client.models({ target: target('rotated') });
  assert.equal(requests.at(-1)?.headers?.authorization, 'Bearer rotated');
});

void test("on OpenAI's own endpoint Icons choose OpenAI for the provider and every model", async (t) => {
  const client = await serve(t, routedTransport({}).transport);
  const ownEndpoints: Record<string, string>[] = [
    {},
    { endpoint: '' },
    { endpoint: 'https://api.openai.com/v1' },
    { endpoint: 'https://api.openai.com:443/v1' },
  ];

  for (const configuration of ownEndpoints) {
    const { modelIconChoice } = await client.icons({
      configuration,
      models: ['a', 'phi4'],
    });

    assert.deepEqual(
      plain(modelIconChoice),
      { provider: 'openai', models: ['openai', 'openai'] },
      JSON.stringify(configuration),
    );
  }
});

void test("on a compatible endpoint Icons choose no own icon and each model's family by name", async (t) => {
  const client = await serve(t, routedTransport({}).transport);

  const { modelIconChoice } = await client.icons({
    configuration: { endpoint: 'http://localhost:11434/v1' },
    models: [
      'Llama3.2',
      'qwen2.5-coder',
      'deepseek-r1-distill-qwen',
      'gemini-pro',
      'gemma3:12b',
      'gpt-oss:20b',
      'claude-3',
      'phi4',
    ],
  });

  // The wire writes a model without an icon as "".
  assert.deepEqual(plain(modelIconChoice), {
    models: [
      'meta',
      'qwen',
      'deepseek',
      'gemini',
      'gemma',
      'openai',
      'claude',
      '',
    ],
  });
});

void test('a look-alike host and a value that is not a URL are compatible endpoints', async (t) => {
  const client = await serve(t, routedTransport({}).transport);

  for (const endpoint of ['https://api.openai.com.example.test', 'not a url']) {
    const { modelIconChoice } = await client.icons({
      configuration: { endpoint },
      models: ['gpt-5', 'phi4'],
    });

    assert.deepEqual(
      plain(modelIconChoice),
      { models: ['openai', ''] },
      endpoint,
    );
  }
});
