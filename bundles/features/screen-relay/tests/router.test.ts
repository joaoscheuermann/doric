// `screen-relay`'s host part through the router (phase 3, slice S49a; spec
// `docs/designs/grpc-processes.md`, section 11, "The HTTP prefix"):
// `screen.relay/v1` served by `createTestRouter` as `src/host/main.ts` serves
// it, and the relay on the part's own loopback listener, which the test binds
// itself (`createTestRouter` ignores `httpServer`). The upstream is a stub
// xpra that echoes what it received, as in `relay.test.ts`.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer, request as httpRequest, type Server } from 'node:http';
import { type AddressInfo, connect, type Socket } from 'node:net';
import test, { type TestContext } from 'node:test';

import { Code, ConnectError } from '@connectrpc/connect';
import { fromConnectError } from 'bundle/contracts';
import { createTestRouter } from 'bundle/testing';

import { RelayService } from '../src/contracts/gen/doric/screen/relay/v1/relay_pb.js';
import { createScreenRelayPart } from '../src/host/part.js';

const MAGIC = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const KEY = 'dGhlIHNhbXBsZSBub25jZQ==';

const acceptOf = (key: string): string =>
  createHash('sha1').update(`${key}${MAGIC}`, 'binary').digest('base64');

const listen = async (server: Server): Promise<number> => {
  await new Promise<void>((resolve) =>
    server.listen(0, '127.0.0.1', () => resolve()),
  );

  return (server.address() as AddressInfo).port;
};

const close = (server: Server): Promise<void> =>
  new Promise((resolve) => {
    if (!server.listening) {
      resolve();

      return;
    }

    server.closeAllConnections();
    server.close(() => resolve());
  });

/** A stub xpra server: what it saw, and the port it listens on. */
interface Upstream {
  readonly port: number;
  /** `METHOD url` of every request and upgrade it received, in order. */
  readonly seen: string[];
}

/**
 * A stub xpra upstream named `name`: answers every request `203` with an
 * `x-upstream` header and a body naming what it received; accepts every
 * WebSocket upgrade with the browser's key and echoes the bytes after it.
 */
const upstreamOf = async (t: TestContext, name: string): Promise<Upstream> => {
  const seen: string[] = [];
  const server = createServer((request, response) => {
    seen.push(`${request.method ?? ''} ${request.url ?? ''}`);
    response.writeHead(203, {
      'content-type': 'text/plain',
      'x-upstream': name,
      'x-seen-host': String(request.headers.host ?? ''),
    });
    response.end(`${name} ${request.method ?? ''} ${request.url ?? ''}`);
  });
  const sockets = new Set<Socket>();

  server.on('upgrade', (request, socket: Socket, head: Buffer) => {
    seen.push(`UPGRADE ${request.url ?? ''}`);
    sockets.add(socket);

    const key = String(request.headers['sec-websocket-key'] ?? '');

    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
        'upgrade: websocket\r\n' +
        'connection: Upgrade\r\n' +
        `sec-websocket-accept: ${acceptOf(key)}\r\n` +
        '\r\n',
    );
    if (head.length > 0) {
      socket.write(head);
    }
    socket.on('data', (chunk: Buffer) => socket.write(chunk));
    socket.on('error', () => undefined);
  });

  const port = await listen(server);

  t.after(async () => {
    for (const socket of sockets) {
      socket.destroy();
    }

    await close(server);
  });

  return { port, seen };
};

/** A loopback port nothing listens on: connecting to it is refused. */
const refusingPort = async (): Promise<number> => {
  const server = createServer();
  const port = await listen(server);

  await close(server);

  return port;
};

/**
 * A fresh part activated on a test router as `main.ts` runs it, with its
 * `httpServer` bound by the test on `127.0.0.1:0`.
 */
const servePart = async (t: TestContext) => {
  const part = createScreenRelayPart();
  const router = createTestRouter({ instance: { bundleId: 'screen-relay' } });

  await router.activate({
    services: [[RelayService, part.implementation]],
    activate: () => undefined,
    deactivate: () => part.deactivate(),
  });

  const port = await listen(part.httpServer);

  t.after(async () => {
    await router.control.stop();
    await close(part.httpServer);
  });

  return { part, router, port, client: router.client(RelayService) };
};

/** One HTTP request to the part's listener, without a keep-alive agent. */
const get = (port: number, path: string) =>
  new Promise<{
    readonly status: number;
    readonly headers: Record<string, string | string[] | undefined>;
    readonly body: string;
  }>((resolve, reject) => {
    const client = httpRequest(
      { host: '127.0.0.1', port, path, agent: false },
      (response) => {
        let body = '';

        response.setEncoding('utf8');
        response.on('data', (chunk: string) => {
          body += chunk;
        });
        response.on('end', () =>
          resolve({
            status: response.statusCode ?? 0,
            headers: response.headers,
            body,
          }),
        );
      },
    );

    client.on('error', reject);
    client.end();
  });

/** Asserts `answer` is the relay's own 404. */
const noSuchScreen = (answer: Awaited<ReturnType<typeof get>>): void => {
  assert.equal(answer.status, 404);
  assert.match(String(answer.headers['content-type']), /^text\/plain/);
  assert.equal(answer.body, 'No such screen.');
};

/**
 * Sends a raw WebSocket upgrade for `path` and answers every byte received
 * until the server closed the socket; fails after 2 s if it stays open.
 */
const rawUpgrade = (port: number, path: string): Promise<string> =>
  new Promise((resolve, reject) => {
    const socket = connect({ host: '127.0.0.1', port });
    const chunks: Buffer[] = [];
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`the upgrade of ${path} was not closed`));
    }, 2_000);

    socket.on('data', (chunk: Buffer) => chunks.push(chunk));
    socket.on('error', () => undefined);
    socket.on('close', () => {
      clearTimeout(timer);
      resolve(Buffer.concat(chunks).toString('latin1'));
    });
    socket.on('connect', () => {
      socket.write(
        `GET ${path} HTTP/1.1\r\n` +
          `host: 127.0.0.1:${port}\r\n` +
          'connection: Upgrade\r\n' +
          'upgrade: websocket\r\n' +
          `sec-websocket-key: ${KEY}\r\n` +
          'sec-websocket-version: 13\r\n' +
          '\r\n',
      );
    });
  });

/** An accepted WebSocket upgrade through the part: its answer and socket. */
const openUpgrade = (port: number, path: string) =>
  new Promise<{
    readonly accept: string;
    readonly socket: Socket;
  }>((resolve, reject) => {
    const client = httpRequest({
      host: '127.0.0.1',
      port,
      path,
      agent: false,
      headers: {
        connection: 'Upgrade',
        upgrade: 'websocket',
        'sec-websocket-key': KEY,
        'sec-websocket-version': '13',
      },
    });

    client.on('error', reject);
    client.on('response', (response) => {
      response.resume();
      reject(new Error(`the upgrade answered ${response.statusCode ?? 0}`));
    });
    client.on('upgrade', (response, socket: Socket) => {
      assert.equal(response.statusCode, 101);
      resolve({
        accept: String(response.headers['sec-websocket-accept'] ?? ''),
        socket,
      });
    });
    client.end();
  });

/** Writes `bytes` on `socket` and answers the first `bytes.length` echoed. */
const roundTrip = (socket: Socket, bytes: Buffer): Promise<Buffer> =>
  new Promise((resolve) => {
    let received = Buffer.alloc(0);
    const onData = (chunk: Buffer) => {
      received = Buffer.concat([received, chunk]);

      if (received.length >= bytes.length) {
        socket.off('data', onData);
        resolve(received);
      }
    };

    socket.on('data', onData);
    socket.write(bytes);
  });

/** Resolves once `socket` closed; fails after 2 s. */
const closed = (socket: Socket): Promise<void> =>
  new Promise((resolve, reject) => {
    if (socket.destroyed) {
      resolve();

      return;
    }

    const timer = setTimeout(
      () => reject(new Error('the socket stayed open')),
      2_000,
    );

    socket.once('close', () => {
      clearTimeout(timer);
      resolve();
    });
  });

/** Asserts a call failed with the gRPC code and the Doric code given. */
const failsWith =
  (grpc: Code, code: string) =>
  (error: unknown): boolean => {
    assert.ok(error instanceof ConnectError, String(error));
    assert.equal(error.code, grpc, `${Code[error.code]}: ${error.rawMessage}`);
    assert.equal(fromConnectError(error).code, code, error.rawMessage);

    return true;
  };

const invalidInput = failsWith(Code.InvalidArgument, 'invalid_input');

void test('A1: an exposed token forwards the path after it, the query and the upstream host, and answers what the upstream answered', async (t) => {
  const upstream = await upstreamOf(t, 'one');
  const { port, client } = await servePart(t);

  await client.expose({ token: 't1', host: '127.0.0.1', port: upstream.port });

  const answer = await get(port, '/screen/t1/a/b?x=1');

  assert.deepEqual(upstream.seen, ['GET /a/b?x=1']);
  assert.equal(answer.status, 203);
  assert.equal(answer.headers['x-upstream'], 'one');
  assert.equal(answer.headers['x-seen-host'], `127.0.0.1:${upstream.port}`);
  assert.equal(answer.body, 'one GET /a/b?x=1');
});

void test('A2: a request sent right after Expose resolved is forwarded', async (t) => {
  const upstream = await upstreamOf(t, 'one');
  const { port, client } = await servePart(t);

  for (let index = 0; index < 20; index += 1) {
    const token = `t${index}`;

    await client.expose({ token, host: '127.0.0.1', port: upstream.port });

    const answer = await get(port, `/screen/${token}/n${index}`);

    assert.equal(answer.status, 203, `token ${token}`);
  }

  assert.equal(upstream.seen.length, 20);
});

void test('A3: exposing a token again with another upstream sends later requests there', async (t) => {
  const first = await upstreamOf(t, 'one');
  const second = await upstreamOf(t, 'two');
  const { port, client } = await servePart(t);

  await client.expose({ token: 't1', host: '127.0.0.1', port: first.port });
  assert.equal((await get(port, '/screen/t1/')).body, 'one GET /');

  await client.expose({ token: 't1', host: '127.0.0.1', port: second.port });

  const answer = await get(port, '/screen/t1/later');

  assert.equal(answer.headers['x-upstream'], 'two');
  assert.deepEqual(first.seen, ['GET /']);
  assert.deepEqual(second.seen, ['GET /later']);
});

void test('A4: Forget stops answering the token, and forgetting an unknown token resolves', async (t) => {
  const upstream = await upstreamOf(t, 'one');
  const { port, client } = await servePart(t);

  await client.expose({ token: 't1', host: '127.0.0.1', port: upstream.port });
  await client.forget({ token: 't1' });

  noSuchScreen(await get(port, '/screen/t1/a'));
  assert.deepEqual(upstream.seen, []);

  const answer = await client.forget({ token: 'never-exposed' });

  assert.equal(answer.$typeName, 'doric.screen.relay.v1.ForgetResponse');
});

void test('A5: an unknown token, /screen and a path outside the tree each answer 404 on the part’s listener', async (t) => {
  const upstream = await upstreamOf(t, 'one');
  const { port, client } = await servePart(t);

  await client.expose({ token: 't1', host: '127.0.0.1', port: upstream.port });

  for (const path of ['/screen/unknown/', '/screen', '/elsewhere']) {
    noSuchScreen(await get(port, path));
  }

  assert.deepEqual(upstream.seen, []);
});

void test('A6: a WebSocket upgrade under an exposed token passes the browser’s handshake through and relays bytes both ways unchanged', async (t) => {
  const upstream = await upstreamOf(t, 'one');
  const { port, client } = await servePart(t);

  await client.expose({ token: 't1', host: '127.0.0.1', port: upstream.port });

  const { accept, socket } = await openUpgrade(port, '/screen/t1/ws?v=1');

  t.after(() => socket.destroy());

  assert.equal(accept, acceptOf(KEY));
  assert.deepEqual(upstream.seen, ['UPGRADE /ws?v=1']);

  const bytes = Buffer.from(Array.from({ length: 256 }, (_, index) => index));

  assert.deepEqual(await roundTrip(socket, bytes), bytes);
});

void test('A7: an upgrade under an unknown token or outside /screen/ gets HTTP/1.1 404 and its socket closes', async (t) => {
  const upstream = await upstreamOf(t, 'one');
  const { port, client } = await servePart(t);

  await client.expose({ token: 't1', host: '127.0.0.1', port: upstream.port });

  for (const path of ['/screen/unknown/ws', '/elsewhere']) {
    const answered = await rawUpgrade(port, path);

    assert.match(answered, /^HTTP\/1\.1 404 /, path);
  }

  assert.deepEqual(upstream.seen, []);
});

void test('A8: an exposed token whose upstream refuses answers 502 to a request and HTTP/1.1 502 to an upgrade, then closes it', async (t) => {
  const refused = await refusingPort();
  const { port, client } = await servePart(t);

  await client.expose({ token: 't1', host: '127.0.0.1', port: refused });

  assert.equal((await get(port, '/screen/t1/')).status, 502);
  assert.match(await rawUpgrade(port, '/screen/t1/ws'), /^HTTP\/1\.1 502 /);
});

void test('A9: Expose with an empty token or host, or a port outside 1..65535, fails invalid_input and exposes nothing', async (t) => {
  const upstream = await upstreamOf(t, 'one');
  const { port, client } = await servePart(t);

  await assert.rejects(
    client.expose({ token: '', host: '127.0.0.1', port: upstream.port }),
    invalidInput,
  );

  for (const request of [
    { token: 'bad', host: '', port: upstream.port },
    { token: 'bad', host: '127.0.0.1', port: 0 },
    { token: 'bad', host: '127.0.0.1', port: 65_536 },
  ]) {
    await assert.rejects(client.expose(request), invalidInput);
  }

  noSuchScreen(await get(port, '/screen/bad/'));
  assert.deepEqual(upstream.seen, []);
});

void test('A10: Forget with an empty token fails invalid_input', async (t) => {
  const { client } = await servePart(t);

  await assert.rejects(client.forget({ token: '' }), invalidInput);
});

void test('A11: stopping the part closes an open relayed upgrade, and Expose fails unavailable afterwards', async (t) => {
  const upstream = await upstreamOf(t, 'one');
  const { port, router, client } = await servePart(t);

  await client.expose({ token: 't1', host: '127.0.0.1', port: upstream.port });

  const { socket } = await openUpgrade(port, '/screen/t1/ws');

  t.after(() => socket.destroy());

  const bytes = Buffer.from('open');

  assert.deepEqual(await roundTrip(socket, bytes), bytes);

  await router.control.stop();
  await closed(socket);

  await assert.rejects(
    client.expose({ token: 't2', host: '127.0.0.1', port: upstream.port }),
    failsWith(Code.Unavailable, 'unavailable'),
  );
});

/** The active TCP handles and pending lookups of this process. */
const networkResources = (): number =>
  process
    .getActiveResourcesInfo()
    .filter((resource) => /^(TCP|Pipe|GetAddrInfo)/.test(resource)).length;

void test('A12: a new part’s httpServer is not listening and building it opened no connection', async () => {
  const before = networkResources();
  const part = createScreenRelayPart();

  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(part.httpServer.listening, false);
  assert.equal(part.httpServer.address(), null);
  assert.ok(
    networkResources() <= before,
    'building the part opened a socket or a lookup',
  );
});

void test('a replayed Expose of the same token and upstream resolves again and keeps serving, open upgrades included', async (t) => {
  const upstream = await upstreamOf(t, 'one');
  const { port, client } = await servePart(t);
  const expose = { token: 't1', host: '127.0.0.1', port: upstream.port };

  await client.expose(expose);

  const { socket } = await openUpgrade(port, '/screen/t1/ws');

  t.after(() => socket.destroy());

  const replayed = await client.expose(expose);

  assert.equal(replayed.$typeName, 'doric.screen.relay.v1.ExposeResponse');
  assert.equal((await get(port, '/screen/t1/again')).status, 203);

  const bytes = Buffer.from('still-open');

  assert.deepEqual(await roundTrip(socket, bytes), bytes);
});
