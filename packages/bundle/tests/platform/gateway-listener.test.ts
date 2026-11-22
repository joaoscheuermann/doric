// The gateway's parts without processes (spec `docs/designs/grpc-processes.md`,
// section 11, "One port, three protocols" and "The HTTP prefix"; T2.9): the
// public listener that tells HTTP/2 from HTTP/1.1 by the client preface, the
// handler of the served methods over gRPC and the Connect protocol, binary
// and JSON, relayed to a fake router (an in-process Connect router, the
// boundary the gateway relays to), and the HTTP prefix proxy to a loopback
// target.

import assert from 'node:assert/strict';
import { once } from 'node:events';
import http from 'node:http';
import http2 from 'node:http2';
import net, { type AddressInfo } from 'node:net';
import test, { describe, type TestContext } from 'node:test';

import type { DescService } from '@bufbuild/protobuf';
import {
  Code,
  ConnectError,
  createClient,
  createConnectRouter,
  type Interceptor,
  type ServiceImpl,
} from '@connectrpc/connect';
import {
  createConnectTransport,
  createGrpcTransport,
  Http2SessionManager,
} from '@connectrpc/connect-node';

import { ContractError } from '../../src/contracts/error.js';
import {
  fromConnectError,
  toConnectError,
} from '../../src/contracts/status.js';
import {
  type CatalogIndex,
  createCatalogIndex,
  type MethodInfo,
} from '../../src/platform/catalog-index.js';
import {
  createGatewayHandler,
  createPrefixProxy,
  type GatewayRelay,
  http2Preface,
  maxJsonRequestBytes,
  type PrefixProxy,
  type PublicListener,
  PublicListenerBindingError,
  type PublicListenerOptions,
  startPublicListener,
} from '../../src/platform/gateway/index.js';
import type { InstanceKey } from '../../src/platform/router/instances.js';
import type { HttpTarget } from '../../src/platform/router/listener.js';
import {
  type DemoClient,
  type DemoMessage,
  demoFile,
  serviceOf,
} from '../support/demo-contract.js';

// ---------------------------------------------------------------------------
// Helpers

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** Resolves with `promise`'s value; fails the test after `timeoutMs`. */
const within = async <T>(
  promise: Promise<T>,
  what: string,
  timeoutMs = 3_000,
): Promise<T> => {
  let timer: NodeJS.Timeout | undefined;

  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`timed out waiting for ${what}`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
};

/** Polls `predicate` until it holds; fails the test after `timeoutMs`. */
const until = async (
  predicate: () => boolean,
  what: string,
  timeoutMs = 2_000,
): Promise<void> => {
  const deadline = performance.now() + timeoutMs;

  while (!predicate()) {
    if (performance.now() > deadline) {
      assert.fail(`timed out waiting for ${what}`);
    }

    await sleep(5);
  }
};

/** The `ConnectError` `promise` rejects with; fails the test when it resolves. */
const failureOf = async (promise: Promise<unknown>): Promise<ConnectError> => {
  try {
    await within(promise, 'the call');
  } catch (error) {
    assert.ok(
      error instanceof ConnectError,
      `expected a ConnectError: ${error}`,
    );

    return error;
  }

  return assert.fail('the call succeeded');
};

const assertFailure = (error: ConnectError, grpc: Code, code: string): void => {
  assert.equal(fromConnectError(error).code, code, error.message);
  assert.equal(error.code, grpc, error.message);
};

/** An answer to a plain HTTP/1.1 request. */
interface HttpAnswer {
  readonly status: number;
  readonly headers: http.IncomingHttpHeaders;
  readonly body: string;
}

/** One HTTP/1.1 request on its own connection. */
const httpRequest = (
  port: number,
  options: {
    readonly method?: string;
    readonly path: string;
    readonly headers?: http.OutgoingHttpHeaders;
    readonly body?: string;
  },
): Promise<HttpAnswer> =>
  within(
    new Promise<HttpAnswer>((resolve, reject) => {
      const request = http.request(
        {
          host: '127.0.0.1',
          port,
          method: options.method ?? 'GET',
          path: options.path,
          headers: options.headers ?? {},
          agent: false,
        },
        (response) => {
          const chunks: Buffer[] = [];

          response.on('data', (chunk: Buffer) => chunks.push(chunk));
          response.on('end', () =>
            resolve({
              status: response.statusCode ?? 0,
              headers: response.headers,
              body: Buffer.concat(chunks).toString(),
            }),
          );
          response.on('error', reject);
        },
      );

      request.on('error', reject);
      request.end(options.body);
    }),
    `${options.method ?? 'GET'} ${options.path}`,
  );

/** A raw TCP connection that records what it receives. */
interface RawSocket {
  readonly socket: net.Socket;
  received(): string;
  /** Resolves when the connection closes. */
  readonly closed: Promise<void>;
  isClosed(): boolean;
}

const openRaw = async (t: TestContext, port: number): Promise<RawSocket> => {
  const socket = net.connect(port, '127.0.0.1');
  let data = '';
  let closed = false;

  socket.on('data', (chunk: Buffer) => {
    data += chunk.toString('latin1');
  });
  socket.on('error', () => {});

  const closing = new Promise<void>((resolve) => {
    socket.on('close', () => {
      closed = true;
      resolve();
    });
  });

  t.after(() => {
    socket.destroy();
  });
  await within(once(socket, 'connect'), 'the connection');

  return {
    socket,
    received: () => data,
    closed: closing,
    isClosed: () => closed,
  };
};

const upgradeRequest = (path: string, head = ''): string =>
  `GET ${path} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: Upgrade\r\nUpgrade: fixture\r\n\r\n${head}`;

/** Listens on `server` at `127.0.0.1:0`; closes it in `after`. */
const listenOn = async (
  t: TestContext,
  server: http.Server | http2.Http2Server,
): Promise<number> => {
  const sockets = new Set<net.Socket>();

  server.on('connection', (socket: net.Socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    for (const socket of sockets) {
      socket.destroy();
    }

    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  return (server.address() as AddressInfo).port;
};

const sessionTo = (t: TestContext, port: number): Http2SessionManager => {
  const session = new Http2SessionManager(`http://127.0.0.1:${port}`);

  t.after(() => session.abort());

  return session;
};

const stamp =
  (headers: Readonly<Record<string, string>>): Interceptor =>
  (next) =>
  (request) => {
    for (const [name, value] of Object.entries(headers)) {
      request.header.set(name, value);
    }

    return next(request);
  };

// ---------------------------------------------------------------------------
// The demo contract and a fake router

const demo = demoFile({ id: 'demo/v1', package: 'demo.v1' });
const demoService = serviceOf(demo, 'DemoService');
const index: CatalogIndex = createCatalogIndex([demo]);

const methodAt = (path: string): MethodInfo => {
  const info = index.method(path);

  assert.ok(info !== undefined, path);

  return info;
};

const echoPath = '/demo.v1.DemoService/Echo';
const watchPath = '/demo.v1.DemoService/Watch';

const notifyPath = '/demo.v1.DemoHandlerService/Notify';

/** The methods the handler serves in these tests: `Echo` and `Watch`. */
const served = (): readonly MethodInfo[] => [
  methodAt(echoPath),
  methodAt(watchPath),
];

/** What the fake router saw of one relayed call. */
interface Relayed {
  readonly path: string;
  readonly clientPart: string | undefined;
  readonly header: Headers;
}

/**
 * A relay that serves `DemoService` itself, as a Connect router over gRPC:
 * `Echo` answers `echo:<text>`, or fails with `invalid_input` for the text
 * `fail`; `Watch` streams `<text>:1`, `<text>:2`, `<text>:3`.
 */
const fakeRelay = (): {
  readonly relay: GatewayRelay;
  readonly seen: Relayed[];
} => {
  const router = createConnectRouter();
  const seen: Relayed[] = [];

  router.service(demoService, {
    echo: (request: DemoMessage) => {
      if (request.text === 'fail') {
        throw toConnectError(new ContractError('invalid_input', 'bad text'));
      }

      return { text: `echo:${request.text}` };
    },
    watch: async function* (request: DemoMessage) {
      for (const n of [1, 2, 3]) {
        yield { text: `${request.text}:${n}` };
      }
    },
  } as unknown as Partial<ServiceImpl<DescService>>);

  const relay: GatewayRelay = async (request, clientPart) => {
    const path = new URL(request.url, 'http://gateway').pathname;

    seen.push({ path, clientPart, header: new Headers(request.header) });

    const handler = router.handlers.find((entry) => entry.requestPath === path);

    assert.ok(handler !== undefined, `the fake router serves ${path}`);

    return handler(request);
  };

  return { relay, seen };
};

/** The handler of `served()` behind an HTTP/2 and an HTTP/1.1 server. */
const serveHandler = async (
  t: TestContext,
): Promise<{
  readonly h2: number;
  readonly h1: number;
  readonly seen: Relayed[];
}> => {
  const { relay, seen } = fakeRelay();
  const handler = createGatewayHandler({ index, methods: served(), relay });
  const h2 = await listenOn(t, http2.createServer(handler));
  const h1 = await listenOn(t, http.createServer(handler));

  return { h2, h1, seen };
};

const grpcClient = (
  t: TestContext,
  port: number,
  headers: Readonly<Record<string, string>> = {},
): DemoClient =>
  createClient(
    demoService,
    createGrpcTransport({
      baseUrl: `http://127.0.0.1:${port}`,
      sessionManager: sessionTo(t, port),
      interceptors: [stamp(headers)],
    }),
  ) as unknown as DemoClient;

const connectClient = (
  t: TestContext,
  port: number,
  options: {
    readonly httpVersion: '1.1' | '2';
    readonly binary: boolean;
  },
  headers: Readonly<Record<string, string>> = {},
): DemoClient =>
  createClient(
    demoService,
    options.httpVersion === '2'
      ? createConnectTransport({
          baseUrl: `http://127.0.0.1:${port}`,
          httpVersion: '2',
          useBinaryFormat: options.binary,
          sessionManager: sessionTo(t, port),
          interceptors: [stamp(headers)],
        })
      : createConnectTransport({
          baseUrl: `http://127.0.0.1:${port}`,
          httpVersion: '1.1',
          useBinaryFormat: options.binary,
          interceptors: [stamp(headers)],
        }),
  ) as unknown as DemoClient;

const collect = async (
  stream: AsyncIterable<DemoMessage>,
): Promise<string[]> => {
  const texts: string[] = [];

  for await (const message of stream) {
    texts.push(message.text);
  }

  return texts;
};

// ---------------------------------------------------------------------------
// The public listener

/** What a recording listener's handlers received. */
interface Received {
  readonly requests: {
    readonly httpVersion: string;
    readonly method: string;
    readonly url: string;
  }[];
  readonly upgrades: string[];
}

const recordingListener = async (
  t: TestContext,
  overrides: Partial<PublicListenerOptions> = {},
): Promise<{
  readonly listener: PublicListener;
  readonly received: Received;
}> => {
  const received: Received = { requests: [], upgrades: [] };
  const listener = await startPublicListener({
    address: '127.0.0.1:0',
    request: (request, response) => {
      received.requests.push({
        httpVersion: request.httpVersion,
        method: request.method ?? '',
        url: request.url ?? '',
      });
      response.statusCode = 200;
      response.end(
        `seen ${request.httpVersion} ${request.method} ${request.url}`,
      );
    },
    upgrade: (request, socket) => {
      received.upgrades.push(request.url ?? '');
      socket.end('HTTP/1.1 418 Upgrade Seen\r\nConnection: close\r\n\r\n');
    },
    ...overrides,
  });

  t.after(() => listener.close());

  return { listener, received };
};

describe('the public listener', () => {
  test('one port takes an HTTP/1.1 request and an HTTP/2 request', async (t) => {
    const { listener, received } = await recordingListener(t);

    const h1 = await httpRequest(listener.port, { path: '/one?x=1' });

    assert.equal(h1.status, 200);
    assert.equal(h1.body, 'seen 1.1 GET /one?x=1');

    const session = http2.connect(`http://127.0.0.1:${listener.port}`);

    t.after(() => session.destroy());
    session.on('error', () => {});

    const stream = session.request({ ':method': 'POST', ':path': '/two' });
    let body = '';

    stream.setEncoding('utf8');
    stream.on('data', (chunk: string) => {
      body += chunk;
    });
    stream.end();
    await within(once(stream, 'end'), 'the HTTP/2 answer');

    assert.equal(body, 'seen 2.0 POST /two');
    assert.deepEqual(
      received.requests.map(({ httpVersion }) => httpVersion),
      ['1.1', '2.0'],
    );
  });

  test('an HTTP/1.1 request whose first bytes match the preface reaches the handler whole', async (t) => {
    const { listener, received } = await recordingListener(t);
    const raw = await openRaw(t, listener.port);

    // "P" matches the preface's first byte; "O" does not match its second.
    raw.socket.write('P');
    await sleep(50);
    raw.socket.write(
      'OST /split HTTP/1.1\r\nHost: x\r\nContent-Length: 0\r\nConnection: close\r\n\r\n',
    );
    await within(raw.closed, 'the answer');

    assert.match(raw.received(), /^HTTP\/1\.1 200/);
    assert.deepEqual(received.requests, [
      { httpVersion: '1.1', method: 'POST', url: '/split' },
    ]);
  });

  test('an HTTP/1.1 upgrade goes to the upgrade handler, not the request handler', async (t) => {
    const { listener, received } = await recordingListener(t);
    const raw = await openRaw(t, listener.port);

    raw.socket.write(upgradeRequest('/screen/ws'));
    await until(() => raw.received().includes('418'), 'the upgrade answer');

    assert.deepEqual(received.upgrades, ['/screen/ws']);
    assert.deepEqual(received.requests, []);
  });

  test('a connection that sends part of the preface is closed after the preface timeout, reaching no handler', async (t) => {
    const { listener, received } = await recordingListener(t, {
      prefaceTimeoutMs: 200,
    });
    const raw = await openRaw(t, listener.port);
    const started = performance.now();

    raw.socket.write(http2Preface.slice(0, 10));
    await within(raw.closed, 'the listener to close the connection', 2_000);

    assert.ok(
      performance.now() - started >= 150,
      'not closed before the timeout',
    );
    assert.deepEqual(received.requests, []);
    assert.deepEqual(received.upgrades, []);
  });

  test('a connection that closes during the preface reaches no handler, and the listener keeps serving', async (t) => {
    const { listener, received } = await recordingListener(t, {
      prefaceTimeoutMs: 200,
    });
    const raw = await openRaw(t, listener.port);

    raw.socket.end(http2Preface.slice(0, 20));
    await within(raw.closed, 'the connection to close');
    await sleep(50);

    assert.deepEqual(received.requests, []);

    const answer = await httpRequest(listener.port, { path: '/after' });

    assert.equal(answer.status, 200);
  });

  for (const address of [
    'localhost',
    '127.0.0.1:',
    '127.0.0.1:http',
    ':::3000',
    '[::1:3000',
  ]) {
    test(`a malformed address (${address}) rejects with PublicListenerBindingError at public_binding`, async () => {
      await assert.rejects(
        startPublicListener({
          address,
          request: () => {},
          upgrade: () => {},
        }),
        (error: unknown) =>
          error instanceof PublicListenerBindingError &&
          error.stage === 'public_binding',
      );
    });
  }

  test('an occupied address rejects with PublicListenerBindingError, the system error as cause', async (t) => {
    const occupant = net.createServer();

    occupant.listen(0, '127.0.0.1');
    await once(occupant, 'listening');
    t.after(() => occupant.close());

    const { port } = occupant.address() as AddressInfo;

    await assert.rejects(
      startPublicListener({
        address: `127.0.0.1:${port}`,
        request: () => {},
        upgrade: () => {},
      }),
      (error: unknown) =>
        error instanceof PublicListenerBindingError &&
        error.stage === 'public_binding' &&
        (error.cause as NodeJS.ErrnoException | undefined)?.code ===
          'EADDRINUSE',
    );
  });

  test('close refuses later connections and destroys open ones; a second close resolves too', async (t) => {
    const { listener } = await recordingListener(t);
    const raw = await openRaw(t, listener.port);

    raw.socket.write(
      'GET /kept HTTP/1.1\r\nHost: x\r\nConnection: keep-alive\r\n\r\n',
    );
    await until(() => raw.received().includes('seen'), 'the answer');

    await within(listener.close(), 'the close');
    await within(listener.close(), 'the second close');
    await within(raw.closed, 'the open connection to be destroyed');

    const refused = net.connect(listener.port, '127.0.0.1');
    const [error] = (await within(once(refused, 'error'), 'the refusal')) as [
      NodeJS.ErrnoException,
    ];

    assert.equal(error.code, 'ECONNREFUSED');
  });
});

// ---------------------------------------------------------------------------
// The handler of the served methods

describe('the gateway handler', () => {
  test('a served unary method over gRPC (HTTP/2) is relayed and answered', async (t) => {
    const { h2, seen } = await serveHandler(t);
    const client = grpcClient(t, h2);

    const answer = await within(client.echo({ text: 'hi' }), 'echo');

    assert.equal(answer.text, 'echo:hi');
    assert.deepEqual(
      seen.map(({ path }) => path),
      [echoPath],
    );
  });

  for (const options of [
    { httpVersion: '2', binary: true },
    { httpVersion: '2', binary: false },
    { httpVersion: '1.1', binary: true },
    { httpVersion: '1.1', binary: false },
  ] as const) {
    const label = `Connect ${options.binary ? 'binary' : 'JSON'} over HTTP/${options.httpVersion}`;

    test(`a served unary method over ${label} is relayed as gRPC and answered in its codec`, async (t) => {
      const { h1, h2, seen } = await serveHandler(t);
      const port = options.httpVersion === '2' ? h2 : h1;
      const client = connectClient(t, port, options);

      const answer = await within(client.echo({ text: 'hi' }), 'echo');

      assert.equal(answer.text, 'echo:hi');
      assert.equal(seen.length, 1);
      assert.equal(
        seen[0]?.header.get('content-type'),
        'application/grpc+proto',
      );
    });

    test(`a served server-streaming method over ${label} streams every message`, async (t) => {
      const { h1, h2 } = await serveHandler(t);
      const port = options.httpVersion === '2' ? h2 : h1;
      const client = connectClient(t, port, options);

      assert.deepEqual(
        await within(collect(client.watch({ text: 'w' })), 'watch'),
        ['w:1', 'w:2', 'w:3'],
      );
    });
  }

  test('a served server-streaming method over gRPC streams every message', async (t) => {
    const { h2 } = await serveHandler(t);

    assert.deepEqual(
      await within(collect(grpcClient(t, h2).watch({ text: 'g' })), 'watch'),
      ['g:1', 'g:2', 'g:3'],
    );
  });

  test("the relayed status keeps its ContractError reason, in the request's protocol", async (t) => {
    const { h1, h2 } = await serveHandler(t);

    assertFailure(
      await failureOf(grpcClient(t, h2).echo({ text: 'fail' })),
      Code.InvalidArgument,
      'invalid_input',
    );
    assertFailure(
      await failureOf(
        connectClient(t, h1, { httpVersion: '1.1', binary: false }).echo({
          text: 'fail',
        }),
      ),
      Code.InvalidArgument,
      'invalid_input',
    );
  });

  test('the relay gets doric-client-part, the forwarded headers and the deadline as grpc-timeout', async (t) => {
    const { h2, seen } = await serveHandler(t);
    const headers = {
      'doric-client-part': 'web',
      'doric-scope-bin': 'CgQKAWESAWI',
      traceparent: '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01',
      'doric-provider': 'alpha',
      'doric-target': 'alpha/1/1',
    };

    await within(
      grpcClient(t, h2, headers).echo({ text: 'hi' }, { timeoutMs: 4_000 }),
      'echo',
    );

    const [relayed] = seen;

    assert.ok(relayed !== undefined);
    assert.equal(relayed.clientPart, 'web');

    for (const name of [
      'doric-scope-bin',
      'traceparent',
      'doric-provider',
      'doric-target',
    ] as const) {
      assert.equal(relayed.header.get(name), headers[name], name);
    }

    assert.match(relayed.header.get('grpc-timeout') ?? '', /^\d+[HMSmun]$/);
  });

  test('without doric-client-part the relay gets no client part', async (t) => {
    const { h1, seen } = await serveHandler(t);

    await within(
      connectClient(t, h1, { httpVersion: '1.1', binary: false }).echo({
        text: 'hi',
      }),
      'echo',
    );

    assert.equal(seen.length, 1);
    assert.equal(seen[0]?.clientPart, undefined);
  });

  test('gRPC-Web answers HTTP 415 and relays nothing', async (t) => {
    const { h1, seen } = await serveHandler(t);

    for (const contentType of [
      'application/grpc-web+proto',
      'application/grpc-web-text',
    ]) {
      const answer = await httpRequest(h1, {
        method: 'POST',
        path: echoPath,
        headers: { 'content-type': contentType, 'x-grpc-web': '1' },
        body: '\u0000\u0000\u0000\u0000\u0000',
      });

      assert.equal(answer.status, 415, contentType);
    }

    assert.deepEqual(seen, []);
  });

  test('a method of the index the gateway does not serve answers UNIMPLEMENTED unknown_contract, relaying nothing', async (t) => {
    const { h1, h2, seen } = await serveHandler(t);

    assertFailure(
      await failureOf(grpcClient(t, h2).hidden({ text: 'x' })),
      Code.Unimplemented,
      'unknown_contract',
    );
    assertFailure(
      await failureOf(
        connectClient(t, h1, { httpVersion: '1.1', binary: false }).hidden({
          text: 'x',
        }),
      ),
      Code.Unimplemented,
      'unknown_contract',
    );

    const notify = await httpRequest(h1, {
      method: 'POST',
      path: notifyPath,
      headers: { 'content-type': 'application/json' },
      body: '{"text":"x"}',
    });

    assert.equal(notify.status, 501, notify.body);
    assert.match(notify.body, /unimplemented/);
    assert.deepEqual(seen, []);
  });

  test('any other path answers HTTP 404', async (t) => {
    const { h1, seen } = await serveHandler(t);

    for (const path of ['/', '/screen/x', '/demo.v1.DemoService']) {
      const answer = await httpRequest(h1, { path });

      assert.equal(answer.status, 404, path);
    }

    assert.deepEqual(seen, []);
  });

  test(`a JSON request message over ${maxJsonRequestBytes} bytes ends with RESOURCE_EXHAUSTED limit_exceeded, relaying nothing`, async (t) => {
    const { h1, h2, seen } = await serveHandler(t);
    // {"text":"<n chars>"} is n + 11 bytes.
    const over = 'a'.repeat(maxJsonRequestBytes - 10);

    for (const client of [
      connectClient(t, h1, { httpVersion: '1.1', binary: false }),
      connectClient(t, h2, { httpVersion: '2', binary: false }),
    ]) {
      assertFailure(
        await failureOf(client.echo({ text: over })),
        Code.ResourceExhausted,
        'limit_exceeded',
      );
    }

    assert.deepEqual(seen, []);
  });

  test(`a JSON request message of exactly ${maxJsonRequestBytes} bytes is relayed`, async (t) => {
    const { h1, seen } = await serveHandler(t);
    const exact = 'a'.repeat(maxJsonRequestBytes - 11);

    const answer = await within(
      connectClient(t, h1, { httpVersion: '1.1', binary: false }).echo({
        text: exact,
      }),
      'echo',
    );

    assert.equal(answer.text, `echo:${exact}`);
    assert.equal(seen.length, 1);
  });
});

// ---------------------------------------------------------------------------
// The HTTP prefix proxy

/** A connection `track` counted. */
interface Tracked {
  readonly key: InstanceKey;
  readonly cancel: () => void;
  released: boolean;
}

/**
 * A loopback target: a request answers 201 with `x-target: yes` and the
 * body `<method> <url> <x-test> <body>` after `delayMs`; an upgrade answers
 * 101, writes `echo:<head>`, then echoes each chunk as `echo:<chunk>`.
 */
const startTarget = async (t: TestContext, delayMs = 0): Promise<number> => {
  const server = http.createServer((request, response) => {
    let body = '';

    request.setEncoding('utf8');
    request.on('data', (chunk: string) => {
      body += chunk;
    });
    request.on('end', () => {
      setTimeout(() => {
        response.writeHead(201, { 'x-target': 'yes' });
        response.end(
          `${request.method} ${request.url} ${String(request.headers['x-test'])} ${body}`,
        );
      }, delayMs);
    });
  });

  server.on('upgrade', (_request, socket: net.Socket, head: Buffer) => {
    socket.on('error', () => {});
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\nUpgrade: fixture\r\nConnection: Upgrade\r\n\r\n',
    );
    socket.write(Buffer.concat([Buffer.from('echo:'), head]));
    socket.on('data', (chunk: Buffer) => {
      socket.write(Buffer.concat([Buffer.from('echo:'), chunk]));
    });
    socket.on('end', () => socket.end());
  });

  return listenOn(t, server);
};

/** A port nothing listens on. */
const closedPort = async (): Promise<number> => {
  const server = net.createServer();

  server.listen(0, '127.0.0.1');
  await once(server, 'listening');

  const { port } = server.address() as AddressInfo;

  await new Promise<void>((resolve) => server.close(() => resolve()));

  return port;
};

/**
 * A proxy over `prefixes` and `targets`, behind an HTTP/1.1 server that
 * answers 404 to a request the proxy does not take and writes
 * `HTTP/1.1 404` to an upgrade it does not take.
 */
const serveProxy = async (
  t: TestContext,
  prefixes: Map<string, string>,
  targets: Map<string, HttpTarget>,
): Promise<{ readonly port: number; readonly tracked: Tracked[] }> => {
  const tracked: Tracked[] = [];
  const proxy: PrefixProxy = createPrefixProxy({
    prefixes: () => prefixes,
    target: (bundleId) => targets.get(bundleId),
    track: (key, cancel) => {
      const entry: Tracked = { key, cancel, released: false };

      tracked.push(entry);

      return () => {
        entry.released = true;
      };
    },
  });
  const server = http.createServer((request, response) => {
    if (!proxy.request(request, response)) {
      response.statusCode = 404;
      response.end('not proxied');
    }
  });

  server.on('upgrade', (request, socket: net.Socket, head: Buffer) => {
    if (!proxy.upgrade(request, socket, head)) {
      socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
    }
  });

  return { port: await listenOn(t, server), tracked };
};

const relayKey = 'relay/1/1' as InstanceKey;

describe('the HTTP prefix proxy', () => {
  test('forwards a request under the prefix with its method, target, headers and body, and answers as the target did', async (t) => {
    const target = await startTarget(t);
    const { port } = await serveProxy(
      t,
      new Map([['/screen/', 'relay']]),
      new Map([['relay', { key: relayKey, port: target }]]),
    );

    const answer = await httpRequest(port, {
      method: 'POST',
      path: '/screen/abc/def?x=1',
      headers: { 'x-test': 'kept', 'content-type': 'text/plain' },
      body: 'payload',
    });

    assert.equal(answer.status, 201);
    assert.equal(answer.headers['x-target'], 'yes');
    assert.equal(answer.body, 'POST /screen/abc/def?x=1 kept payload');
  });

  test('a proxied request counts as in flight of the target instance until its answer ends', async (t) => {
    const target = await startTarget(t, 200);
    const { port, tracked } = await serveProxy(
      t,
      new Map([['/screen/', 'relay']]),
      new Map([['relay', { key: relayKey, port: target }]]),
    );

    const answer = httpRequest(port, { path: '/screen/slow' });

    await until(() => tracked.length === 1, 'the request to be tracked');

    assert.equal(tracked[0]?.key, relayKey);
    assert.equal(tracked[0]?.released, false);

    assert.equal((await answer).status, 201);
    await until(() => tracked[0]?.released === true, 'the release');
  });

  test('a path that only starts like the prefix, or is under another one, is not taken', async (t) => {
    const target = await startTarget(t);
    const { port, tracked } = await serveProxy(
      t,
      new Map([['/screen/', 'relay']]),
      new Map([['relay', { key: relayKey, port: target }]]),
    );

    for (const path of ['/screen', '/screens/x', '/other/x', '/']) {
      const answer = await httpRequest(port, { path });

      assert.equal(answer.status, 404, path);
      assert.equal(answer.body, 'not proxied', path);
    }

    assert.deepEqual(tracked, []);
  });

  test('reads the prefixes on every request', async (t) => {
    const target = await startTarget(t);
    const prefixes = new Map<string, string>();
    const { port } = await serveProxy(
      t,
      prefixes,
      new Map([['relay', { key: relayKey, port: target }]]),
    );

    assert.equal((await httpRequest(port, { path: '/screen/a' })).status, 404);

    prefixes.set('/screen/', 'relay');

    assert.equal((await httpRequest(port, { path: '/screen/a' })).status, 201);

    prefixes.delete('/screen/');

    assert.equal((await httpRequest(port, { path: '/screen/a' })).status, 404);
  });

  test('a prefix whose bundle has no target answers 503', async (t) => {
    const { port } = await serveProxy(
      t,
      new Map([['/screen/', 'relay']]),
      new Map(),
    );

    assert.equal((await httpRequest(port, { path: '/screen/a' })).status, 503);
  });

  test('a target that refuses the connection answers 502', async (t) => {
    const { port } = await serveProxy(
      t,
      new Map([['/screen/', 'relay']]),
      new Map([['relay', { key: relayKey, port: await closedPort() }]]),
    );

    assert.equal((await httpRequest(port, { path: '/screen/a' })).status, 502);
  });

  test('forwards an upgrade byte for byte both ways, counted while open', async (t) => {
    const target = await startTarget(t);
    const { port, tracked } = await serveProxy(
      t,
      new Map([['/screen/', 'relay']]),
      new Map([['relay', { key: relayKey, port: target }]]),
    );
    const raw = await openRaw(t, port);

    raw.socket.write(upgradeRequest('/screen/ws', 'first'));
    await until(() => raw.received().includes('echo:first'), 'the head echoed');

    assert.match(raw.received(), /^HTTP\/1\.1 101/);

    raw.socket.write(Buffer.from([0x01, 0xff, ...Buffer.from('binary')]));
    await until(
      () => raw.received().includes('echo:\u0001\u00ffbinary'),
      'raw bytes echoed',
    );

    assert.equal(tracked.length, 1);
    assert.equal(tracked[0]?.key, relayKey);
    assert.equal(tracked[0]?.released, false);

    raw.socket.end();
    await until(() => tracked[0]?.released === true, 'the release on close');
  });

  test('cancel destroys a proxied upgrade, as the drain deadline does', async (t) => {
    const target = await startTarget(t);
    const { port, tracked } = await serveProxy(
      t,
      new Map([['/screen/', 'relay']]),
      new Map([['relay', { key: relayKey, port: target }]]),
    );
    const raw = await openRaw(t, port);

    raw.socket.write(upgradeRequest('/screen/ws', 'x'));
    await until(() => raw.received().includes('echo:x'), 'the upgrade');

    tracked[0]?.cancel();

    await within(raw.closed, 'the connection to be destroyed');
  });

  test('an upgrade without a target gets HTTP/1.1 503, then the socket closes', async (t) => {
    const { port } = await serveProxy(
      t,
      new Map([['/screen/', 'relay']]),
      new Map(),
    );
    const raw = await openRaw(t, port);

    raw.socket.write(upgradeRequest('/screen/ws'));
    await within(raw.closed, 'the socket to close');

    assert.match(raw.received(), /^HTTP\/1\.1 503/);
  });

  test('an upgrade whose target refuses the connection gets HTTP/1.1 502, then the socket closes', async (t) => {
    const { port } = await serveProxy(
      t,
      new Map([['/screen/', 'relay']]),
      new Map([['relay', { key: relayKey, port: await closedPort() }]]),
    );
    const raw = await openRaw(t, port);

    raw.socket.write(upgradeRequest('/screen/ws'));
    await within(raw.closed, 'the socket to close');

    assert.match(raw.received(), /^HTTP\/1\.1 502/);
  });

  test('an upgrade under no prefix is not taken', async (t) => {
    const target = await startTarget(t);
    const { port, tracked } = await serveProxy(
      t,
      new Map([['/screen/', 'relay']]),
      new Map([['relay', { key: relayKey, port: target }]]),
    );
    const raw = await openRaw(t, port);

    raw.socket.write(upgradeRequest('/elsewhere/ws'));
    await within(raw.closed, 'the socket to close');

    assert.match(raw.received(), /^HTTP\/1\.1 404/);
    assert.deepEqual(tracked, []);
  });
});
