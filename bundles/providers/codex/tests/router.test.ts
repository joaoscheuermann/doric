// `codex`'s `models.provider/v1` 1.4.0 through the router (spec
// `docs/designs/grpc-processes.md`, "Model providers"; phase 3, slice S43):
// `kindSource(codexKind, …)` served by `llms/rpc`'s `serveProviderKind` on
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

import { codexKind } from '../src/host/kind.js';
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

/** `codex`'s `models.provider/v1` over `transport`, on a fresh test router. */
const serve = async (t: TestContext, transport: HttpTransport) => {
  const router = createTestRouter();

  t.after(() => router.control.stop());

  await router.activate({
    services: [
      [
        ProviderService,
        serveProviderKind(
          kindSource(codexKind, {
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

const sse = (payload: unknown): string =>
  `data: ${JSON.stringify(payload)}\n\n`;

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

/** Asserts `promise` failed with a ConnectError of the Doric code `code`. */
const rejectsWithCode = async (promise: Promise<unknown>, code: string) => {
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

    return true;
  });
};

void test('Kind answers the frozen codex kind through the router', async (t) => {
  const client = await serve(t, routedTransport({}).transport);

  const { modelKindDescriptor } = await client.kind({});

  assert.ok(modelKindDescriptor !== undefined);
  assert.deepEqual(
    plain(modelKindDescriptor),
    plain({
      ...frozenKind(),
      lists: [...(providerKind('codex')?.lists ?? [])],
    }),
  );
});

void test('Models sends one request to the target’s endpoint with its authorization and account id', async (t) => {
  const { requests, transport } = routedTransport({
    answer: () => ({ body: { data: [{ id: 'gpt-5.5' }] } }),
  });
  const client = await serve(t, transport);

  const { models } = await client.models({
    target: {
      providerId: 'cx',
      values: {
        endpoint: 'https://codex.test/backend',
        chatGptAccountId: 'acct_1',
      },
      secret: 'Bearer codex-tok',
    },
  });

  assert.equal(requests.length, 1);
  assert.equal(requests[0]?.url, 'https://codex.test/backend/models');
  assert.equal(requests[0]?.headers?.authorization, 'Bearer codex-tok');
  assert.equal(requests[0]?.headers?.['ChatGPT-Account-ID'], 'acct_1');
  assert.deepEqual(
    models.map((model) => model.id),
    ['gpt-5.5'],
  );
});

void test('Complete answers the parsed Codex response', async (t) => {
  const { transport } = routedTransport({
    stream: [
      sse({
        type: 'response.completed',
        response: { status: 'completed', output_text: 'ok', output: [] },
      }),
      'data: [DONE]\n\n',
    ],
  });
  const client = await serve(t, transport);

  const { providerFinished } = await client.complete(
    completion(
      { providerId: 'cx', values: {}, secret: 'Bearer codex-tok' },
      'gpt-5.5',
    ),
  );

  assert.equal(providerFinished?.text, 'ok');
  assert.equal(providerFinished?.finishReason, 'stop');
});

void test('Catalog is absent, and reads nothing', async (t) => {
  const { requests, transport } = routedTransport({});
  const client = await serve(t, transport);

  const { catalogResult } = await client.catalog({
    configuration: {},
    secret: 'Bearer codex-tok',
  });

  assert.equal(catalogResult?.status, 'absent');
  assert.equal(requests.length, 0);
});

void test('a target without its required token fails with invalid_input', async (t) => {
  const client = await serve(t, routedTransport({}).transport);

  await rejectsWithCode(
    client.models({ target: { providerId: 'cx', values: {} } }),
    'invalid_input',
  );
});
