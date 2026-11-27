// The screen relay: the HTTP + WebSocket forwarding of the Project screens,
// reached on the origin the host already exposes. The app embeds
// `/screen/<token>/` on that origin, and the relay forwards every request of
// that token tree to the Project sandbox's xpra server — assets over plain
// HTTP, the live stream over a WebSocket.
//
// The app never reaches a listener of its own. A loopback URL that only the
// host machine can answer is exactly what breaks the product when the host
// runs on a remote server while the app runs on a laptop: the app has to reach
// the screen on the same origin it reaches the host on. The gateway sends every
// request and upgrade under `/screen/` to this part's own listener (`serve`),
// which is why this file belongs to `screen-relay` and not to the
// generation-side `screen`.
//
// The WebSocket is forwarded transparently: the relay terminates the upgrade
// with the browser and performs its own upgrade with xpra, both with the
// browser's own `Sec-WebSocket-Key` and handshake headers, and then pipes the
// raw bytes in both directions. Negotiated subprotocols and extensions
// therefore reach xpra exactly as the browser offered them, and no frame is
// parsed or rewritten. Only token trees the relay knows are answered.
//
// Security: the relay is no longer bound to `127.0.0.1`. It is served on the
// origin the operator exposes, so whoever can reach that origin and holds the
// token can watch and drive the screen. The token stays the capability; the
// operator's network boundary (tunnel, reverse proxy, VPN) becomes the
// control, consistent with the host's HTTP surface being unauthenticated by
// design (see `bundles/foundation/transport/src/host/api/operations/credentials.ts`).

import {
  request as httpRequest,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import { connect, type Socket } from 'node:net';

import type { ScreenRelayTarget } from '../contracts/index.js';

/**
 * The relay itself: the local face `screen.relay/v1` is defined over, plus its
 * listener. The token argument comes first here because this is the object
 * the host part owns; the contract's single-object `expose` is what crosses
 * processes, and `rpc/relay.ts` adapts one to the other.
 */
export interface ScreenRelayServer {
  /** Registers (or replaces) the upstream of one session token. */
  expose(token: string, target: ScreenRelayTarget): void;
  /** Drops a token; its requests answer 404 afterwards. */
  forget(token: string): void;
  /**
   * Serves the relay as the only handler of `server`: the part's own loopback
   * listener (`BundleDefinition.httpServer`), which the gateway sends every
   * request and upgrade under `/screen/` with its target unchanged (spec
   * section 11, "The HTTP prefix").
   *
   * Accepts a plain `http.Server` with no `request` or `upgrade` listener of
   * its own; listening or not. From the call on:
   * - a request under `/screen/<token>/` of an exposed token is forwarded
   *   (path after the token, query kept, `host` rewritten, hop-by-hop headers
   *   dropped); an unreachable upstream answers 502;
   * - any other request (an unknown token, `/screen`, a path outside the
   *   tree) answers 404 `No such screen.`, `text/plain`;
   * - an upgrade of an exposed token is forwarded byte for byte;
   *   any other upgrade gets `HTTP/1.1 404 Not Found` and its socket is
   *   closed (nothing else owns upgrades on this listener).
   *
   * Returns a function that detaches both listeners; idempotent. It neither
   * closes `server` (the SDK does, after `deactivate`) nor drops tokens.
   * `dispose` still destroys every relayed socket. Never throws.
   */
  serve(server: Server): () => void;
  dispose(): void;
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
  const parsed = new URL(url ?? '/', 'http://screen.invalid');
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

/** One resolved relay request. */
type ResolvedScreen = NonNullable<ReturnType<typeof relayTarget>>;

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

export const createScreenRelay = (): ScreenRelayServer => {
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
    resolved: ResolvedScreen,
    request: IncomingMessage,
    response: ServerResponse,
  ): void => {
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
    resolved: ResolvedScreen,
    request: IncomingMessage,
    socket: Socket,
    head: Buffer,
  ): void => {
    track(socket);

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

  return {
    expose: (token, target) => {
      sessions.set(token, target);
    },
    forget: (token) => {
      sessions.delete(token);
    },
    serve: (server) => {
      // The part's own listener: nothing sits behind the relay, so whatever
      // it does not know answers 404 here, upgrades included.
      const serveRequest = (
        request: IncomingMessage,
        response: ServerResponse,
      ): void => {
        const resolved = relayTarget(request.url, sessions);

        if (resolved === undefined) {
          response.writeHead(404, { 'content-type': 'text/plain' });
          response.end('No such screen.');

          return;
        }

        proxyHttp(resolved, request, response);
      };
      const serveUpgrade = (
        request: IncomingMessage,
        socket: Socket,
        head: Buffer,
      ): void => {
        const resolved = relayTarget(request.url, sessions);

        if (resolved === undefined) {
          answer(socket, 404, 'Not Found');

          return;
        }

        proxyUpgrade(resolved, request, socket, head);
      };

      server.on('request', serveRequest);
      server.on('upgrade', serveUpgrade);

      return () => {
        server.off('request', serveRequest);
        server.off('upgrade', serveUpgrade);
      };
    },
    dispose: () => {
      for (const socket of [...open]) {
        socket.destroy();
      }
    },
  };
};
