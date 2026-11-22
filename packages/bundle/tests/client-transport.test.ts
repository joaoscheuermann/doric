// The client SDK's transport and client part (spec
// `docs/designs/grpc-processes.md`, section 10, `bundle/client`; section 11,
// "The calling client part", D34; T2.12): one Connect transport per client
// part over `fetch`, naming the part in `doric-client-part`, never carrying
// `doric-caller*`, and refusing a request over 4 MiB before it is sent. Every
// test passes a fake `fetch`, the network boundary, and reads what it got.

import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import {
  create,
  type DescMessage,
  fromBinary,
  toBinary,
} from '@bufbuild/protobuf';
import { Code, ConnectError, createClient } from '@connectrpc/connect';

import { ContractError } from '../src/contracts/error.js';
import { toConnectError } from '../src/contracts/status.js';
import {
  createClientPart,
  createClientPartTransport,
  fromConnectError,
  maxMessageBytes,
} from '../src/sdk/client/index.js';
import {
  type DemoClient,
  demoFile,
  serviceOf,
} from './support/demo-contract.js';

// ---------------------------------------------------------------------------
// Helpers

const file = demoFile({ id: 'demo/v1', package: 'demo.v1' });
const DemoService = serviceOf(file, 'DemoService');

const messageOf = (name: string): DescMessage => {
  const found = file.messages.find((message) => message.name === name);

  assert.ok(found !== undefined, name);

  return found;
};

const RequestSchema = messageOf('Request');
const ResponseSchema = messageOf('Response');

/** One request the fake `fetch` received. */
interface Sent {
  readonly url: string;
  readonly method: string;
  readonly headers: Headers;
  readonly body: Uint8Array;
}

/** A Connect unary answer: the binary `Response { text }`. */
const answer = (text: string): Response =>
  new Response(toBinary(ResponseSchema, create(ResponseSchema, { text })), {
    status: 200,
    headers: { 'content-type': 'application/proto' },
  });

/** A `fetch` that records every request and answers with `respond`. */
const fakeFetch = (
  respond: () => Response | Promise<Response> = () => answer('ok'),
): { readonly sent: Sent[]; readonly fetch: typeof globalThis.fetch } => {
  const sent: Sent[] = [];
  const fetch = async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const request = new Request(input, {
      ...init,
      duplex: 'half',
    } as RequestInit);

    sent.push({
      url: request.url,
      method: request.method,
      headers: request.headers,
      body: new Uint8Array(await request.arrayBuffer()),
    });

    return respond();
  };

  return { sent, fetch: fetch as typeof globalThis.fetch };
};

const demoClient = (
  fetch: typeof globalThis.fetch,
  baseUrl = 'http://127.0.0.1:4000',
): DemoClient =>
  createClient(
    DemoService,
    createClientPartTransport({ bundleId: 'app', baseUrl, fetch }),
  ) as unknown as DemoClient;

/** The `ConnectError` `promise` rejects with; fails the test when it resolves. */
const failureOf = async (promise: Promise<unknown>): Promise<ConnectError> => {
  try {
    await promise;
  } catch (error) {
    assert.ok(
      error instanceof ConnectError,
      `expected a ConnectError: ${error}`,
    );

    return error;
  }

  return assert.fail('the call succeeded');
};

/** A text whose `Request { text }` is exactly `bytes` long in binary. */
const textOfSize = (bytes: number): string => {
  // Tag (1 byte) and a 4-byte length varint (2^21 <= length < 2^28).
  const text = 'x'.repeat(bytes - 5);

  assert.equal(
    toBinary(RequestSchema, create(RequestSchema, { text })).byteLength,
    bytes,
  );

  return text;
};

/**
 * A Connect error answer as the gateway writes one for `error`: its gRPC
 * code by name and its details, each `{ type, value }` in base64.
 */
const errorAnswer = (error: ContractError): Response => {
  const connect = toConnectError(error);
  const details = connect.details.map((detail) => {
    assert.ok('desc' in detail, 'a detail with its descriptor');

    return {
      type: detail.desc.typeName,
      value: Buffer.from(
        toBinary(detail.desc, create(detail.desc, detail.value)),
      )
        .toString('base64')
        .replace(/=+$/, ''),
    };
  });

  return new Response(
    JSON.stringify({
      code: 'permission_denied',
      message: connect.rawMessage,
      details,
    }),
    { status: 403, headers: { 'content-type': 'application/json' } },
  );
};

// ---------------------------------------------------------------------------
// The headers

describe('createClientPartTransport: headers', () => {
  test('every call carries doric-client-part: <bundleId>, replacing the call options value', async () => {
    const { sent, fetch } = fakeFetch();
    const client = demoClient(fetch);

    assert.equal((await client.echo({ text: 'a' })).text, 'ok');
    await client.echo(
      { text: 'b' },
      { headers: { 'doric-client-part': 'someone-else' } },
    );

    assert.deepEqual(
      sent.map(({ headers }) => headers.get('doric-client-part')),
      ['app', 'app'],
    );
  });

  test('no header starting with doric-caller is sent, whatever the call options set', async () => {
    const { sent, fetch } = fakeFetch();

    await demoClient(fetch).echo(
      { text: 'a' },
      {
        headers: {
          'doric-caller': 'core',
          'doric-caller-incarnation': '3',
          'doric-caller-anything': 'x',
        },
      },
    );

    assert.equal(sent.length, 1);
    assert.deepEqual(
      [...(sent[0]?.headers.keys() ?? [])].filter((name) =>
        name.startsWith('doric-caller'),
      ),
      [],
    );
  });

  test("a method's URL is <baseUrl>/<package>.<Service>/<Method>, with or without a trailing slash", async () => {
    const { sent, fetch } = fakeFetch();

    await demoClient(fetch, 'http://127.0.0.1:4000').echo({ text: 'a' });
    await demoClient(fetch, 'http://127.0.0.1:4000/').echo({ text: 'b' });

    assert.deepEqual(
      sent.map(({ method, url }) => `${method} ${url}`),
      [
        'POST http://127.0.0.1:4000/demo.v1.DemoService/Echo',
        'POST http://127.0.0.1:4000/demo.v1.DemoService/Echo',
      ],
    );
  });

  test('without options.fetch it calls globalThis.fetch, read when the call starts', async (t) => {
    const original = globalThis.fetch;
    const transport = createClientPartTransport({
      bundleId: 'app',
      baseUrl: 'http://127.0.0.1:4000',
    });
    const { sent, fetch } = fakeFetch();

    t.after(() => {
      globalThis.fetch = original;
    });
    globalThis.fetch = fetch;

    const client = createClient(
      DemoService,
      transport,
    ) as unknown as DemoClient;

    assert.equal((await client.echo({ text: 'a' })).text, 'ok');
    assert.equal(sent.length, 1);
  });
});

// ---------------------------------------------------------------------------
// The 4 MiB limit (T2.12)

describe('createClientPartTransport: the message limit', () => {
  test('a request of exactly 4 MiB is sent', async () => {
    const { sent, fetch } = fakeFetch();
    const text = textOfSize(maxMessageBytes);

    assert.equal((await demoClient(fetch).echo({ text })).text, 'ok');
    assert.equal(sent.length, 1);
    assert.equal(
      (
        fromBinary(
          RequestSchema,
          sent[0]?.body ?? new Uint8Array(),
        ) as unknown as {
          text: string;
        }
      ).text.length,
      text.length,
    );
  });

  test('a request of 4 MiB + 1 is refused before it is sent: RESOURCE_EXHAUSTED, limit_exceeded', async () => {
    const { sent, fetch } = fakeFetch();
    const error = await failureOf(
      demoClient(fetch).echo({ text: textOfSize(maxMessageBytes + 1) }),
    );

    assert.equal(error.code, Code.ResourceExhausted, error.message);
    assert.equal(fromConnectError(error).code, 'limit_exceeded');
    assert.deepEqual(sent, []);
  });
});

// ---------------------------------------------------------------------------
// Failures

describe('createClientPartTransport: failures', () => {
  test('a network failure is a ConnectError UNAVAILABLE that fromConnectError reads as unavailable', async () => {
    const fetch = (async () => {
      throw new TypeError('fetch failed');
    }) as typeof globalThis.fetch;
    const error = await failureOf(demoClient(fetch).echo({ text: 'a' }));

    assert.equal(error.code, Code.Unavailable, error.message);
    assert.equal(fromConnectError(error).code, 'unavailable');
  });

  test("the gateway's error keeps its Doric code: undeclared_requirement", async () => {
    const { fetch } = fakeFetch(() =>
      errorAnswer(
        new ContractError('undeclared_requirement', 'app does not declare it.'),
      ),
    );
    const error = await failureOf(demoClient(fetch).echo({ text: 'a' }));

    assert.equal(error.code, Code.PermissionDenied, error.message);
    assert.equal(fromConnectError(error).code, 'undeclared_requirement');
  });
});

// ---------------------------------------------------------------------------
// Options it refuses

describe('createClientPartTransport and createClientPart: options', () => {
  const refused: readonly (readonly [string, string])[] = [
    ['', 'http://127.0.0.1:4000'],
    ['app', 'ftp://127.0.0.1:4000'],
    ['app', '/relative/path'],
    ['app', 'not a url'],
    ['app', 'file:///tmp/socket'],
  ];

  test('an empty bundleId or a baseUrl that is not an absolute http(s) URL throws a TypeError', () => {
    for (const [bundleId, baseUrl] of refused) {
      assert.throws(
        () => createClientPartTransport({ bundleId, baseUrl }),
        TypeError,
        `${JSON.stringify(bundleId)} ${baseUrl}`,
      );
      assert.throws(
        () => createClientPart({ bundleId, baseUrl }),
        TypeError,
        `${JSON.stringify(bundleId)} ${baseUrl}`,
      );
    }
  });

  test('https base URLs are accepted', () => {
    assert.doesNotThrow(() =>
      createClientPartTransport({
        bundleId: 'app',
        baseUrl: 'https://doric.example:8443',
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// createClientPart

describe('createClientPart', () => {
  test('names its bundle id, and use makes no call; its calls go through its transport', async () => {
    const { sent, fetch } = fakeFetch();
    const part = createClientPart({
      bundleId: 'app',
      baseUrl: 'http://127.0.0.1:4000',
      fetch,
    });

    assert.equal(part.bundleId, 'app');

    const client = part.use(DemoService) as unknown as DemoClient;

    assert.equal(sent.length, 0, 'use made no call');
    assert.equal((await client.echo({ text: 'a' })).text, 'ok');
    assert.equal(sent[0]?.headers.get('doric-client-part'), 'app');
  });
});
