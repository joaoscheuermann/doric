// Electron main's one Connect connection to the host (spec
// `docs/designs/grpc-processes.md`, section 13, "Electron main to the host"):
// the `api.status/v1` watch that is the connection status, its retries, the
// two ways of hearing about them, and the forward a window's Connect stream
// travels on. The host's status is an in-memory Connect transport over a stub
// `StatusService` (the contract's `transport` seam); the forward's cases also
// answer on a loopback `node:http2` server, the forward's real boundary.

import assert from 'node:assert/strict';
import {
  constants,
  createServer,
  type Http2Server,
  type Http2Session,
  type IncomingHttpHeaders,
  type ServerHttp2Stream,
} from 'node:http2';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, mock, test } from 'node:test';

import { create, type DescService } from '@bufbuild/protobuf';
import {
  Code,
  ConnectError,
  createRouterTransport,
  type HandlerContext,
  type ServiceImpl,
  type Transport,
} from '@connectrpc/connect';
import {
  ReadySchema,
  StatusService,
  WatchResponseSchema,
} from 'transport/contracts/gen/doric/api/status/v1/status_pb.js';

import {
  CONNECTION_RETRY_MS,
  type ConnectionStatus,
  connectHost,
  HOST_URL,
  type HostConnection,
} from '../src/platform/host/connect';

/** One step a stub watch takes: its first item, its clean end, or a refusal. */
type Step =
  | { readonly kind: 'ready' }
  | { readonly kind: 'end' }
  | { readonly kind: 'fail'; readonly error: unknown };

/** One opening of `StatusService.Watch`, driven by the test. */
interface Attempt {
  readonly signal: AbortSignal;
  /** The handler's generator has ended, for any reason. */
  closed: boolean;
  /** Queues the first item. */
  item(): void;
  /** Ends the stream without an error. */
  end(): void;
  /** Fails the attempt before it yields (`onStatus` must report it). */
  fail(error: unknown): void;
  take(): Promise<Step | 'closed'>;
}

/**
 * The host's status service: each `Watch` opening is one attempt, which the
 * test drives step by step. A cancelled opening (`close`, `retry`, a drop)
 * aborts its signal and ends its generator.
 */
const fakeHost = () => {
  const attempts: Attempt[] = [];

  const open = (signal: AbortSignal): Attempt => {
    const queued: Step[] = [];
    let wake: (() => void) | undefined;
    const push = (step: Step): void => {
      queued.push(step);
      const release = wake;

      wake = undefined;
      release?.();
    };

    return {
      signal,
      closed: false,
      item: () => push({ kind: 'ready' }),
      end: () => push({ kind: 'end' }),
      fail: (error) => push({ kind: 'fail', error }),
      take: async () => {
        for (;;) {
          const next = queued.shift();

          if (next !== undefined) {
            return next;
          }

          if (signal.aborted) {
            return 'closed';
          }

          await new Promise<void>((resolve) => {
            wake = resolve;
            signal.addEventListener('abort', () => resolve(), { once: true });
          });
          wake = undefined;
        }
      },
    };
  };

  const transport = createRouterTransport((router) => {
    router.service(StatusService, {
      watch: async function* (_request: unknown, context: HandlerContext) {
        const attempt = open(context.signal);

        attempts.push(attempt);

        try {
          for (;;) {
            const step = await attempt.take();

            if (step === 'closed' || step.kind === 'end') {
              return;
            }

            if (step.kind === 'fail') {
              throw step.error;
            }

            yield create(WatchResponseSchema, {
              event: { case: 'ready', value: create(ReadySchema) },
            });
          }
        } finally {
          attempt.closed = true;
        }
      },
    } as unknown as ServiceImpl<DescService>);
  });

  return { transport, attempts };
};

/** Every connection a test opened, closed again after it. */
const opened: HostConnection[] = [];

const connect = (transport: Transport, url = HOST_URL): HostConnection => {
  const connection = connectHost({ url, transport });

  opened.push(connection);

  return connection;
};

/** Runs the pending microtasks and immediate callbacks to quiescence. */
const settle = async (): Promise<void> => {
  for (let index = 0; index < 20; index += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
};

/** Waits until `predicate` holds, without a fixed sleep. */
const until = async (
  predicate: () => boolean,
  what: string,
): Promise<void> => {
  for (let index = 0; index < 500; index += 1) {
    if (predicate()) {
      return;
    }

    await new Promise<void>((resolve) => setImmediate(resolve));
  }

  throw new Error(`Timed out waiting for ${what}`);
};

/**
 * The outcome of a forwarded request: its error, or `undefined` when the host
 * answered the whole body.
 */
const forwardOutcome = async (
  connection: HostConnection,
  signal: AbortSignal,
): Promise<unknown> => {
  try {
    const response = await connection.forward.request(
      {
        path: '/doric.api.status.v1.StatusService/Watch',
        headers: [['content-type', 'application/connect+json']],
        body: new Uint8Array(),
      },
      signal,
    );

    for await (const chunk of response.body) {
      void chunk;
    }

    return undefined;
  } catch (error) {
    return error;
  }
};

/** One request the loopback host received. */
interface Received {
  readonly headers: IncomingHttpHeaders;
  readonly stream: ServerHttp2Stream;
  /** The request's body, once the request has ended. */
  readonly body: Promise<Uint8Array>;
}

/** A loopback HTTP/2 host that hands each request to `answer`. */
interface LoopbackHost {
  readonly url: string;
  readonly received: Received[];
  close(): Promise<void>;
}

const servers: LoopbackHost[] = [];
const controllers: AbortController[] = [];

const loopbackHost = async (
  answer: (received: Received) => void,
): Promise<LoopbackHost> => {
  const server: Http2Server = createServer();
  const sessions = new Set<Http2Session>();
  const received: Received[] = [];

  server.on('session', (session) => {
    sessions.add(session);
    session.once('close', () => sessions.delete(session));
  });
  server.on('stream', (stream, headers) => {
    const chunks: Buffer[] = [];
    const body = new Promise<Uint8Array>((resolve) => {
      stream.on('data', (chunk: Buffer) => chunks.push(chunk));
      stream.once('end', () => resolve(new Uint8Array(Buffer.concat(chunks))));
    });
    const one = { headers, stream, body };

    received.push(one);
    answer(one);
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));

  const { port } = server.address() as AddressInfo;
  const host: LoopbackHost = {
    url: `http://127.0.0.1:${port}`,
    received,
    close: async () => {
      for (const session of sessions) {
        session.destroy();
      }

      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };

  servers.push(host);

  return host;
};

/** A connection to `host` whose status watch has reported its first item. */
const connectedTo = async (host: LoopbackHost): Promise<HostConnection> => {
  const status = fakeHost();
  const connection = connect(status.transport, host.url);

  await until(() => status.attempts.length === 1, 'the first watch');
  status.attempts[0].item();
  await until(() => connection.status() === 'connected', 'the first item');

  return connection;
};

/** A signal the test aborts after it, so no forwarded stream outlives it. */
const testSignal = (): AbortController => {
  const controller = new AbortController();

  controllers.push(controller);

  return controller;
};

/** `promise`, or a rejection naming `what` after `ms`. */
const within = async <T>(
  promise: Promise<T>,
  what: string,
  ms = 2_000,
): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;

  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`Timed out after ${ms} ms waiting for ${what}`)),
          ms,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
};

const bytesOf = async (body: AsyncIterable<Uint8Array>): Promise<Uint8Array> => {
  const chunks: Uint8Array[] = [];

  for await (const chunk of body) {
    chunks.push(chunk);
  }

  return new Uint8Array(Buffer.concat(chunks));
};

const FORWARDED_PATH = '/acme.notes.v1.NotesService/Get';

/** Bytes no text decoding would leave unchanged. */
const REQUEST_BODY = new Uint8Array([0, 0, 0, 0, 3, 0xff, 0x80, 0x0a]);
const RESPONSE_BODY = new Uint8Array([0x0d, 0x00, 0xfe, 0x7f, 0x01]);

afterEach(async () => {
  for (const controller of controllers.splice(0)) {
    controller.abort();
  }

  for (const connection of opened.splice(0)) {
    connection.close();
  }

  for (const server of servers.splice(0)) {
    await server.close();
  }

  try {
    mock.timers.reset();
  } catch {
    // No test of this file enabled them.
  }
});

describe('host connection', () => {
  test('status is disconnected until the watch reports its first item, then connected', async () => {
    const host = fakeHost();
    const connection = connect(host.transport);

    await until(() => host.attempts.length === 1, 'the first watch');
    assert.equal(connection.url, HOST_URL);
    assert.equal(connection.status(), 'disconnected');

    host.attempts[0].item();
    await until(() => connection.status() === 'connected', 'the first item');

    assert.deepEqual(host.attempts.length, 1);
  });

  test('an ended watch reports disconnected and reopens after CONNECTION_RETRY_MS, and a refused attempt reports its error', async () => {
    mock.timers.enable({ apis: ['setTimeout'] });

    const host = fakeHost();
    const connection = connect(host.transport);
    const statuses: { connected: boolean; error?: string }[] = [];

    connection.onStatus((status: { connected: boolean; error?: string }) =>
      statuses.push(status),
    );

    await until(() => host.attempts.length === 1, 'the first watch');
    host.attempts[0].item();
    await until(() => connection.status() === 'connected', 'the first item');

    host.attempts[0].end();
    await until(
      () => connection.status() === 'disconnected',
      'the watch to end',
    );

    assert.deepEqual(host.attempts.length, 1);

    mock.timers.tick(CONNECTION_RETRY_MS);
    await until(() => host.attempts.length === 2, 'the reopened watch');

    host.attempts[1].fail(new ConnectError('host down', Code.Unavailable));
    await until(
      () => statuses.at(-1)?.error !== undefined,
      'the refused attempt',
    );

    assert.equal(connection.status(), 'disconnected');
    assert.deepEqual(
      statuses.map((status) => status.connected),
      [true, false, false],
    );
    assert.ok(
      (statuses.at(-1)?.error ?? '').includes('host down'),
      `the refusal is reported: ${JSON.stringify(statuses)}`,
    );

    // It keeps reopening every `CONNECTION_RETRY_MS`, refused or not.
    mock.timers.tick(CONNECTION_RETRY_MS);
    await until(() => host.attempts.length === 3, 'the next reopened watch');
  });

  test('retry reopens the watch at once, and close ends it, stops reopening and is idempotent', async () => {
    mock.timers.enable({ apis: ['setTimeout'] });

    const host = fakeHost();
    const connection = connect(host.transport);

    await until(() => host.attempts.length === 1, 'the first watch');

    connection.retry();
    await until(() => host.attempts.length === 2, 'the retried watch');
    await until(() => host.attempts[0].closed, 'the first watch to end');

    host.attempts[1].item();
    await until(() => connection.status() === 'connected', 'the first item');

    connection.close();
    await until(() => host.attempts[1].closed, 'close to end the watch');
    assert.equal(connection.status(), 'disconnected');

    mock.timers.tick(CONNECTION_RETRY_MS * 3);
    await settle();
    assert.deepEqual(host.attempts.length, 2);

    connection.close();
    connection.retry();
    await settle();
    assert.deepEqual(host.attempts.length, 2);
  });

  test('subscribe and status hear changes only, while onStatus hears every attempt', async () => {
    mock.timers.enable({ apis: ['setTimeout'] });

    const host = fakeHost();
    const connection = connect(host.transport);
    const changes: ConnectionStatus[] = [];
    const statuses: { connected: boolean; error?: string }[] = [];

    connection.subscribe((status: ConnectionStatus) => changes.push(status));
    connection.onStatus((status: { connected: boolean; error?: string }) =>
      statuses.push(status),
    );

    await until(() => host.attempts.length === 1, 'the first watch');
    host.attempts[0].item();
    await until(() => connection.status() === 'connected', 'the first item');

    // A subscriber hears nothing at subscribe time, then only changes.
    const late: ConnectionStatus[] = [];

    connection.subscribe((status: ConnectionStatus) => late.push(status));

    assert.deepEqual(late, []);

    host.attempts[0].end();
    await until(
      () => connection.status() === 'disconnected',
      'the watch to end',
    );

    mock.timers.tick(CONNECTION_RETRY_MS);
    await until(
      () => host.attempts.length === 2,
      'the reopened attempt after a drop',
    );
    host.attempts[1].fail(new ConnectError('refused', Code.Unavailable));
    await until(
      () => statuses.length === 3,
      'the refused attempt to report',
    );

    // A refused attempt is no status change, but `onStatus` hears it.
    assert.deepEqual(changes, ['connected', 'disconnected']);
    assert.deepEqual(
      statuses.map((status) => status.connected),
      [true, false, false],
    );
    assert.ok(
      (statuses.at(-1)?.error ?? '').includes('refused'),
      `the refusal is reported: ${JSON.stringify(statuses)}`,
    );
  });

  test('a forwarded request while the connection is down ends with unavailable for the window', async () => {
    const host = fakeHost();
    // A port nothing listens on: a correct connection refuses the forward
    // without dialling it, and a refused dial still reads the same.
    const connection = connect(host.transport, 'http://127.0.0.1:1');

    await until(() => host.attempts.length === 1, 'the first watch');
    assert.equal(connection.status(), 'disconnected');

    const outcome = await forwardOutcome(connection, AbortSignal.timeout(5_000));

    assert.equal(
      (outcome as { code?: string } | undefined)?.code,
      'unavailable',
      `the window reads UNAVAILABLE: ${String(outcome)}`,
    );
  });

  test('a forwarded unary request reaches the host with its path, headers and body, and the window reads the host’s status, headers and body', async () => {
    const host = await loopbackHost(({ stream, body }) => {
      // Headers at once; the body's answer once the request's body is whole.
      stream.respond({
        ':status': 200,
        'content-type': 'application/proto',
        'x-host-answer': 'ok',
      });
      void body.then(() => stream.end(RESPONSE_BODY));
    });
    const connection = await connectedTo(host);
    const controller = testSignal();

    const response = await within(
      connection.forward.request(
        {
          path: FORWARDED_PATH,
          headers: [
            ['content-type', 'application/proto'],
            ['connect-protocol-version', '1'],
            ['X-Window-Trace', 'A1'],
            ['connection', 'keep-alive'],
            ['host', 'elsewhere.example'],
            ['keep-alive', 'timeout=5'],
            ['proxy-connection', 'keep-alive'],
            ['transfer-encoding', 'chunked'],
            ['upgrade', 'h2c'],
            ['content-length', '999'],
          ],
          body: REQUEST_BODY,
        },
        controller.signal,
      ),
      'the host’s response headers',
    );
    const answered = await within(
      bytesOf(response.body),
      'the host’s response body (it answers once the request body has ended)',
    );

    assert.equal(host.received.length, 1);

    const [{ headers, body }] = host.received;

    assert.equal(headers[':method'], 'POST');
    assert.equal(headers[':path'], FORWARDED_PATH);
    assert.equal(headers['content-type'], 'application/proto');
    assert.equal(headers['connect-protocol-version'], '1');
    assert.equal(headers['x-window-trace'], 'A1');

    for (const refused of [
      'connection',
      'host',
      'keep-alive',
      'proxy-connection',
      'transfer-encoding',
      'upgrade',
    ]) {
      assert.equal(headers[refused], undefined, `${refused} is not forwarded`);
    }

    assert.notEqual(headers['content-length'], '999');
    assert.deepEqual(await body, REQUEST_BODY);

    assert.equal(response.status, 200);
    assert.ok(
      response.headers.some(
        ([name, value]) => name === 'content-type' && value === 'application/proto',
      ),
      `content-type is read: ${JSON.stringify(response.headers)}`,
    );
    assert.ok(
      response.headers.some(
        ([name, value]) => name === 'x-host-answer' && value === 'ok',
      ),
      `the host's own header is read: ${JSON.stringify(response.headers)}`,
    );
    assert.ok(
      response.headers.every(([name]) => !name.startsWith(':')),
      'no pseudo-header is a Connect header',
    );
    assert.deepEqual(answered, RESPONSE_BODY);
  });

  test('a forwarded request ends after its body, so a host that answers on the request’s end answers', async () => {
    // As Connect does for a unary call: nothing, not even headers, before
    // the request has ended.
    const host = await loopbackHost(({ stream, body }) => {
      void body.then((bytes) => {
        stream.respond({ ':status': 200, 'content-type': 'application/proto' });
        stream.end(bytes);
      });
    });
    const connection = await connectedTo(host);
    const controller = testSignal();

    const response = await within(
      connection.forward.request(
        {
          path: FORWARDED_PATH,
          headers: [['content-type', 'application/proto']],
          body: REQUEST_BODY,
        },
        controller.signal,
      ),
      'a host that answers on the request’s end',
    );

    assert.equal(response.status, 200);
    assert.deepEqual(
      await within(bytesOf(response.body), 'the echoed body'),
      REQUEST_BODY,
    );
  });

  test('a streamed response is read chunk by chunk, before the host ends it', async () => {
    let firstRead!: () => void;
    const first = new Promise<void>((resolve) => {
      firstRead = resolve;
    });
    const host = await loopbackHost(({ stream }) => {
      stream.respond({
        ':status': 200,
        'content-type': 'application/connect+proto',
      });
      stream.write(new Uint8Array([1, 1, 1]));
      // The second chunk waits for the window to have read the first.
      void first.then(() => stream.end(new Uint8Array([2, 2])));
    });
    const connection = await connectedTo(host);
    const controller = testSignal();

    const response = await within(
      connection.forward.request(
        {
          path: FORWARDED_PATH,
          headers: [['content-type', 'application/connect+proto']],
          body: REQUEST_BODY,
        },
        controller.signal,
      ),
      'the stream’s response headers',
    );
    const reader = response.body[Symbol.asyncIterator]();

    const one = await within(reader.next(), 'the first chunk');

    assert.equal(one.done, false);
    assert.deepEqual(new Uint8Array(one.value), new Uint8Array([1, 1, 1]));

    firstRead();

    const two = await within(reader.next(), 'the second chunk');

    assert.equal(two.done, false);
    assert.deepEqual(new Uint8Array(two.value), new Uint8Array([2, 2]));
    assert.equal((await within(reader.next(), 'the stream’s end')).done, true);
  });

  test('aborting the caller’s signal cancels the forwarded stream at the host', async () => {
    const host = await loopbackHost(({ stream }) => {
      stream.respond({
        ':status': 200,
        'content-type': 'application/connect+proto',
      });
      // One chunk, and the stream stays open until the window cancels it.
      stream.write(new Uint8Array([1]));
    });
    const connection = await connectedTo(host);
    const controller = testSignal();

    const response = await within(
      connection.forward.request(
        {
          path: FORWARDED_PATH,
          headers: [['content-type', 'application/connect+proto']],
          body: REQUEST_BODY,
        },
        controller.signal,
      ),
      'the stream’s response headers',
    );
    const reader = response.body[Symbol.asyncIterator]();

    assert.equal((await within(reader.next(), 'the first chunk')).done, false);

    const [{ stream }] = host.received;
    const closed = new Promise<number>((resolve) => {
      if (stream.closed) {
        resolve(stream.rstCode ?? -1);
      } else {
        stream.once('close', () => resolve(stream.rstCode ?? -1));
      }
    });

    controller.abort();

    assert.equal(
      await within(closed, 'the host to see the stream close'),
      constants.NGHTTP2_CANCEL,
    );
  });
});
