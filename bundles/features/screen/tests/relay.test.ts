// The relay through real sockets: its path mapping, the HTTP proxy, the
// transparent WebSocket passthrough (including the handshake the browser
// offered), the 404s and disposal. The upstream is a stub that echoes what it
// received; no frame is ever parsed by either side.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer, request as httpRequest, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import test, { after } from 'node:test';

import {
  createScreenRelay,
  relayTarget,
  type ScreenRelay,
} from '../src/host/relay.js';

const MAGIC = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

const acceptOf = (key: string): string =>
  createHash('sha1').update(`${key}${MAGIC}`, 'binary').digest('base64');

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

const relays: ScreenRelay[] = [];

const relayWith = async (): Promise<ScreenRelay> => {
  await upstreamReady;
  const relay = await createScreenRelay();

  relays.push(relay);

  return relay;
};

/** The relay's ephemeral port, as its own origin spells it. */
const portOf = (relay: ScreenRelay): number =>
  Number(new URL(relay.origin).port);

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
  const relay = await relayWith();

  relay.expose('t1', { host: '127.0.0.1', port: upstreamPort });

  const answer = await requestOver(portOf(relay), '/screen/t1/hello?q=1');

  assert.equal(answer.status, 200);
  assert.equal(answer.headers['x-seen-path'], '/hello?q=1');
  assert.equal(answer.headers['x-seen-host'], `127.0.0.1:${upstreamPort}`);
  assert.equal(answer.body, 'upstream GET /hello?q=1');
});

test('an unknown token answers 404 without reaching the upstream', async () => {
  const relay = await relayWith();

  const answer = await requestOver(portOf(relay), '/screen/unknown/');

  assert.equal(answer.status, 404);
});

test('the WebSocket upgrade is passed through with the browser handshake', async () => {
  const relay = await relayWith();

  relay.expose('t1', { host: '127.0.0.1', port: upstreamPort });

  const key = 'dGhlIHNhbXBsZSBub25jZQ==';
  const echoed = await new Promise<string>((resolve, reject) => {
    const client = httpRequest({
      host: '127.0.0.1',
      port: portOf(relay),
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
  const relay = await relayWith();

  const status = await new Promise<number>((resolve, reject) => {
    const client = httpRequest({
      host: '127.0.0.1',
      port: portOf(relay),
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

test('dispose closes the listener', async () => {
  const relay = await relayWith();

  await relay.dispose();

  await assert.rejects(requestOver(portOf(relay), '/screen/t1/'));
});

after(async () => {
  await upstreamReady;

  for (const relay of relays) {
    await relay.dispose();
  }

  await new Promise<void>((resolve) => upstream.close(() => resolve()));
});
