// The relay through real sockets, mounted on the host's shared router and
// server: its path mapping, the HTTP proxy, the transparent WebSocket
// passthrough (including the handshake the browser offered), the 404s, the
// pass-through of the host's other routes, coexistence with a second upgrade
// protocol and disposal. The upstream is a stub that echoes what it received;
// no frame is ever parsed by either side.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  createServer,
  request as httpRequest,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import test, { after } from 'node:test';

import {
  createScreenRelay,
  relayTarget,
  type ScreenRelayRouter,
  type ScreenRelayServer,
} from '../src/host/relay.js';

const MAGIC = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

const acceptOf = (key: string): string =>
  createHash('sha1').update(`${key}${MAGIC}`, 'binary').digest('base64');

type Middleware = (
  request: IncomingMessage,
  response: ServerResponse,
  next: (error?: unknown) => void,
) => void;

/**
 * The host's shared router, reduced to the `use` the relay mounts through:
 * middleware runs in order and `next()` continues, as on the host's Express
 * app.
 */
class Router implements ScreenRelayRouter {
  readonly #stack: Middleware[] = [];

  use(handler: Middleware): unknown {
    this.#stack.push(handler);

    return undefined;
  }

  handle(request: IncomingMessage, response: ServerResponse): void {
    let index = 0;
    const next = (): void => {
      const handler = this.#stack[index];
      index += 1;

      if (handler === undefined) {
        response.writeHead(404);
        response.end();

        return;
      }

      handler(request, response, next);
    };

    next();
  }
}

const listen = async (server: Server): Promise<number> => {
  await new Promise<void>((resolve) =>
    server.listen(0, '127.0.0.1', () => resolve()),
  );

  return (server.address() as AddressInfo).port;
};

const upstream = createServer((request, response) => {
  response.writeHead(200, {
    'content-type': 'text/plain',
    'x-seen-path': request.url ?? '',
    'x-seen-host': String(request.headers.host ?? ''),
  });
  response.end(`upstream ${request.method ?? ''} ${request.url ?? ''}`);
});
upstream.on('upgrade', (request, socket, head) => {
  const key = String(request.headers['sec-websocket-key'] ?? '');
  const protocol = request.headers['sec-websocket-protocol'];

  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
      'upgrade: websocket\r\n' +
      'connection: Upgrade\r\n' +
      `sec-websocket-accept: ${acceptOf(key)}\r\n` +
      (protocol === undefined
        ? ''
        : `sec-websocket-protocol: ${protocol}\r\n`) +
      '\r\n',
  );
  for (const chunk of [head]) {
    if (chunk.length > 0) socket.write(chunk);
  }
  socket.on('data', (chunk: Buffer) => socket.write(chunk));
});

let upstreamPort = 0;
const upstreamReady = listen(upstream).then((port) => {
  upstreamPort = port;
});

const relays: ScreenRelayServer[] = [];
const servers: Server[] = [];

/**
 * The host's shared listener with one marker route the relay must not swallow,
 * and the ephemeral port the client reaches it on.
 */
const hostListener = async (): Promise<{
  router: Router;
  server: Server;
  port: number;
}> => {
  await upstreamReady;
  const router = new Router();

  router.use((request, response, next) => {
    if (request.url === '/host-route') {
      response.writeHead(200, { 'content-type': 'text/plain' });
      response.end('host');

      return;
    }

    next();
  });

  const server = createServer((request, response) =>
    router.handle(request, response),
  );

  servers.push(server);

  return { router, server, port: await listen(server) };
};

/** Mounts a fresh relay on a fresh shared host and returns both. */
const relayOnHost = async (): Promise<{
  relay: ScreenRelayServer;
  port: number;
  unmount: () => void;
}> => {
  const host = await hostListener();
  const relay = createScreenRelay();

  relays.push(relay);

  const unmount = relay.mount({ http: host.router, server: host.server });

  return { relay, port: host.port, unmount };
};

const requestOver = (
  port: number,
  path: string,
  headers: Record<string, string> = {},
) =>
  new Promise<{
    status: number;
    headers: Record<string, string | string[] | undefined>;
    body: string;
  }>((resolve, reject) => {
    const client = httpRequest(
      { host: '127.0.0.1', port, path, headers },
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

test('relayTarget maps token trees and refuses everything else', () => {
  const sessions = new Map([['t1', { host: '172.17.0.2', port: 14500 }]]);

  assert.deepEqual(relayTarget('/screen/t1/js/x.js?q=1', sessions), {
    token: 't1',
    target: { host: '172.17.0.2', port: 14500 },
    path: '/js/x.js?q=1',
  });
  assert.equal(relayTarget('/screen/t1', sessions)?.path, '/');
  assert.equal(relayTarget('/screen/other/', sessions), undefined);
  assert.equal(relayTarget('/elsewhere', sessions), undefined);
  assert.equal(relayTarget(undefined, sessions), undefined);
});

test('the HTTP proxy forwards the path, method and rewritten host', async () => {
  const { relay, port } = await relayOnHost();

  relay.expose('t1', { host: '127.0.0.1', port: upstreamPort });

  const answer = await requestOver(port, '/screen/t1/hello?q=1');

  assert.equal(answer.status, 200);
  assert.equal(answer.headers['x-seen-path'], '/hello?q=1');
  assert.equal(answer.headers['x-seen-host'], `127.0.0.1:${upstreamPort}`);
  assert.equal(answer.body, 'upstream GET /hello?q=1');
});

test('an unknown token answers 404 without reaching the upstream', async () => {
  const { relay, port } = await relayOnHost();

  relay.expose('t1', { host: '127.0.0.1', port: upstreamPort });

  const answer = await requestOver(port, '/screen/unknown/');

  assert.equal(answer.status, 404);
});

test("the relay leaves the host's other routes alone", async () => {
  const { relay, port } = await relayOnHost();

  relay.expose('t1', { host: '127.0.0.1', port: upstreamPort });

  const answer = await requestOver(port, '/host-route');

  assert.equal(answer.status, 200);
  assert.equal(answer.body, 'host');
});

test('the WebSocket upgrade is passed through with the browser handshake', async () => {
  const { relay, port } = await relayOnHost();

  relay.expose('t1', { host: '127.0.0.1', port: upstreamPort });

  const key = 'dGhlIHNhbXBsZSBub25jZQ==';
  const echoed = await new Promise<string>((resolve, reject) => {
    const client = httpRequest({
      host: '127.0.0.1',
      port,
      path: '/screen/t1/ws?v=1',
      headers: {
        connection: 'Upgrade',
        upgrade: 'websocket',
        'sec-websocket-key': key,
        'sec-websocket-version': '13',
        'sec-websocket-protocol': 'binary',
      },
    });

    client.on('error', reject);
    client.on('upgrade', (response, socket, head) => {
      assert.equal(response.statusCode, 101);
      assert.equal(response.headers['sec-websocket-accept'], acceptOf(key));
      assert.equal(response.headers['sec-websocket-protocol'], 'binary');
      assert.equal(head.length, 0);

      socket.on('data', (chunk: Buffer) => resolve(chunk.toString('utf8')));
      socket.write('raw-payload');
    });
    client.end();
  });

  assert.equal(echoed, 'raw-payload');
});

test('an unknown token refuses the upgrade', async () => {
  const { port } = await relayOnHost();

  const status = await new Promise<number>((resolve, reject) => {
    const client = httpRequest({
      host: '127.0.0.1',
      port,
      path: '/screen/unknown/',
      headers: {
        connection: 'Upgrade',
        upgrade: 'websocket',
        'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==',
        'sec-websocket-version': '13',
      },
    });

    client.on('error', reject);
    client.on('response', (response) => {
      response.resume();
      resolve(response.statusCode ?? 0);
    });
    client.end();
  });

  assert.equal(status, 404);
});

test('an engine.io-style destroy timer does not end a relayed upgrade', async () => {
  const host = await hostListener();

  // Engine.IO attaches its own `upgrade` listener to the shared server; for a
  // path that is not its own it ends a socket that has not written bytes
  // within `destroyUpgradeTimeout`. The host disables that
  // (`destroyUpgrade: false`); a hostile default would still not end a relayed
  // upgrade that writes its handshake promptly.
  host.server.on('upgrade', (request, socket) => {
    if (request.url?.startsWith('/socket.io')) {
      return;
    }

    const peer = socket as Socket;

    setTimeout(() => {
      if (peer.writable && peer.bytesWritten <= 0) {
        peer.end();
      }
    }, 20);
  });

  const relay = createScreenRelay();

  relays.push(relay);
  relay.mount({ http: host.router, server: host.server });
  relay.expose('t1', { host: '127.0.0.1', port: upstreamPort });

  const key = 'dGhlIHNhbXBsZSBub25jZQ==';
  const echoed = await new Promise<string>((resolve, reject) => {
    const client = httpRequest({
      host: '127.0.0.1',
      port: host.port,
      path: '/screen/t1/ws',
      headers: {
        connection: 'Upgrade',
        upgrade: 'websocket',
        'sec-websocket-key': key,
        'sec-websocket-version': '13',
      },
    });

    client.on('error', reject);
    client.on('upgrade', (response, socket) => {
      assert.equal(response.statusCode, 101);

      socket.on('data', (chunk: Buffer) => resolve(chunk.toString('utf8')));
      socket.write('still-here');
    });
    client.end();
  });

  assert.equal(echoed, 'still-here');
});

test('forget stops answering a token', async () => {
  const { relay, port } = await relayOnHost();

  relay.expose('t1', { host: '127.0.0.1', port: upstreamPort });
  assert.equal((await requestOver(port, '/screen/t1/')).status, 200);

  relay.forget('t1');
  assert.equal((await requestOver(port, '/screen/t1/')).status, 404);
});

test('unmounting stops the relay answering while the host keeps serving', async () => {
  const { relay, port, unmount } = await relayOnHost();

  relay.expose('t1', { host: '127.0.0.1', port: upstreamPort });
  assert.equal((await requestOver(port, '/screen/t1/')).status, 200);

  unmount();

  assert.equal((await requestOver(port, '/screen/t1/')).status, 404);
  assert.equal((await requestOver(port, '/host-route')).status, 200);
});

after(async () => {
  await upstreamReady;

  for (const relay of relays) {
    relay.dispose();
  }

  await Promise.all(
    servers.map(
      (server) => new Promise<void>((resolve) => server.close(() => resolve())),
    ),
  );

  await new Promise<void>((resolve) => upstream.close(() => resolve()));
});
