// The screen relay: one loopback-only HTTP + WebSocket server, owned by the
// `screen` bundle inside a host generation. The desktop panel embeds
// `<origin>/screen/<token>/`, and the relay forwards every request of that
// tree to the Project sandbox's xpra server — assets over plain HTTP, the
// live stream over a WebSocket.
//
// The WebSocket is forwarded transparently: the relay terminates the
// upgrade with the browser and performs its own upgrade with xpra, both with
// the browser's own `Sec-WebSocket-Key` and handshake headers, and then pipes
// the raw bytes in both directions. Negotiated subprotocols and extensions
// therefore reach xpra exactly as the browser offered them, and no frame is
// parsed or rewritten. Nothing outside the token trees is answered, and the
// server only ever binds `127.0.0.1`.

import { createServer, request as httpRequest, type Server } from 'node:http';
import { connect, type Socket } from 'node:net';
import type { AddressInfo } from 'node:net';

/** Where one screen session's xpra server listens, as the host reaches it. */
export interface ScreenRelayTarget {
  readonly host: string;
  readonly port: number;
}

export interface ScreenRelay {
  /** `http://127.0.0.1:<port>`, the origin every panel URL starts with. */
  readonly origin: string;
  /** Registers (or replaces) the upstream of one session token. */
  expose(token: string, target: ScreenRelayTarget): void;
  /** Drops a token; its requests answer 404 afterwards. */
  forget(token: string): void;
  dispose(): Promise<void>;
}

/** The path prefix every relayed request starts with. */
const PREFIX = '/screen/';

/** Headers the relay must not forward between the two HTTP ends. */
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

const failure = (status: number, text: string) =>
  `HTTP/1.1 ${status} ${text}\r\nconnection: close\r\ncontent-length: 0\r\n\r\n`;

/** The token and the upstream path of one relayed request, else undefined. */
export const relayTarget = (
  url: string | undefined,
  sessions: ReadonlyMap<string, ScreenRelayTarget>,
):
  | {
      readonly token: string;
      readonly target: ScreenRelayTarget;
      /** The upstream path, starting with `/`; query included. */
      readonly path: string;
    }
  | undefined => {
  const parsed = new URL(url ?? '/', 'http://127.0.0.1');
  const pathname = parsed.pathname;

  if (!pathname.startsWith(PREFIX)) {
    return undefined;
  }

  const rest = pathname.slice(PREFIX.length);
  const end = rest.indexOf('/');
  const token = end === -1 ? rest : rest.slice(0, end);
  const target = sessions.get(token);

  if (target === undefined) {
    return undefined;
  }

  const path = end === -1 ? '/' : rest.slice(end);
  const query = parsed.search;

  return { token, target, path: `${path}${query}` };
};

const forwardHeaders = (
  headers: readonly string[],
  host: string,
  drop: ReadonlySet<string>,
): Record<string, string> => {
  const forwarded: Record<string, string> = { host };

  for (let index = 0; index + 1 < headers.length; index += 2) {
    const name = headers[index] ?? '';
    const value = headers[index + 1] ?? '';
    const lower = name.toLowerCase();

    if (lower === 'host' || drop.has(lower)) {
      continue;
    }

    forwarded[lower] = value;
  }

  return forwarded;
};

/** Headers an upgrade must keep: the handshake is the payload. */
const NOTHING_DROPPED: ReadonlySet<string> = new Set();

export const createScreenRelay = async (): Promise<ScreenRelay> => {
  const sessions = new Map<string, ScreenRelayTarget>();
  const open = new Set<Socket>();

  const track = (socket: Socket): Socket => {
    open.add(socket);
    socket.once('close', () => open.delete(socket));

    return socket;
  };

  const answer = (socket: Socket, status: number, text: string): void => {
    socket.write(failure(status, text));
    socket.destroy();
  };

  const proxyHttp = (
    request: import('node:http').IncomingMessage,
    response: import('node:http').ServerResponse,
  ): void => {
    const resolved = relayTarget(request.url, sessions);

    if (resolved === undefined) {
      response.writeHead(404, { 'content-type': 'text/plain' });
      response.end('No such screen.');

      return;
    }

    const upstream = httpRequest({
      host: resolved.target.host,
      port: resolved.target.port,
      method: request.method,
      path: resolved.path,
      headers: forwardHeaders(
        request.rawHeaders,
        `${resolved.target.host}:${resolved.target.port}`,
        HOP_BY_HOP,
      ),
    });

    upstream.setTimeout(30_000, () => {
      upstream.destroy(new Error('The screen upstream timed out.'));
    });
    upstream.on('response', (answerUpstream) => {
      const headers: Record<string, string | string[]> = {};

      for (const [name, value] of Object.entries(answerUpstream.headers)) {
        if (value === undefined || HOP_BY_HOP.has(name.toLowerCase())) {
          continue;
        }

        headers[name] = value;
      }

      response.writeHead(answerUpstream.statusCode ?? 502, headers);
      answerUpstream.pipe(response);
    });
    upstream.on('error', () => {
      if (!response.headersSent) {
        response.writeHead(502, { 'content-type': 'text/plain' });
      }

      response.end('The screen upstream is unavailable.');
    });
    request.pipe(upstream);
  };

  const proxyUpgrade = (
    request: import('node:http').IncomingMessage,
    socket: Socket,
    head: Buffer,
  ): void => {
    track(socket);

    const resolved = relayTarget(request.url, sessions);

    if (resolved === undefined) {
      answer(socket, 404, 'Not Found');

      return;
    }

    const upstream = track(
      connect({ host: resolved.target.host, port: resolved.target.port }),
    );
    let accepted = false;

    upstream.setTimeout(0);
    upstream.once('error', () => {
      if (accepted) {
        socket.destroy();

        return;
      }

      answer(socket, 502, 'Bad Gateway');
    });
    upstream.once('close', () => socket.destroy());
    socket.once('close', () => upstream.destroy());
    socket.once('error', () => upstream.destroy());

    upstream.once('connect', () => {
      const lines = [
        `GET ${resolved.path} HTTP/1.1`,
        ...Object.entries(
          forwardHeaders(
            request.rawHeaders,
            `${resolved.target.host}:${resolved.target.port}`,
            NOTHING_DROPPED,
          ),
        ).map(([name, value]) => `${name}: ${value}`),
        '',
        '',
      ];
      const answerHead = Buffer.from(lines.join('\r\n'), 'latin1');
      const answered: Buffer[] = [];
      let buffered = Buffer.alloc(0);

      upstream.write(answerHead);
      if (head.length > 0) {
        upstream.write(head);
      }

      const forwarded = () => {
        // The browser's upgrade is acknowledged as xpra answered it, accept
        // hash included, so the browser validates a handshake that used its
        // own key and no byte is rewritten.
        socket.write(Buffer.concat(answered));
        accepted = true;
        socket.pipe(upstream);
        upstream.pipe(socket);
      };

      const onData = (chunk: Buffer) => {
        buffered = Buffer.concat([buffered, chunk]);

        const end = buffered.indexOf('\r\n\r\n');

        if (end === -1) {
          return;
        }

        answered.push(buffered.subarray(0, end + 4));

        const rest = buffered.subarray(end + 4);

        if (rest.length > 0) {
          answered.push(rest);
        }

        upstream.off('data', onData);
        forwarded();
      };

      upstream.on('data', onData);
    });
  };

  const server: Server = createServer((request, response) => {
    proxyHttp(request, response);
  });
  server.on('upgrade', (request, socket, head) => {
    proxyUpgrade(request, socket as Socket, head);
  });
  server.on('clientError', (_error, socket) => {
    const asSocket = socket as Socket;

    if (!asSocket.destroyed) {
      asSocket.end(failure(400, 'Bad Request'));
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });

  const { port } = server.address() as AddressInfo;

  return {
    origin: `http://127.0.0.1:${port}`,
    expose: (token, target) => {
      sessions.set(token, target);
    },
    forget: (token) => {
      sessions.delete(token);
    },
    dispose: async () => {
      for (const socket of [...open]) {
        socket.destroy();
      }

      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
};
