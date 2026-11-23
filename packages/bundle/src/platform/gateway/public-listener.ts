// The public listener (spec `docs/designs/grpc-processes.md`, section 11,
// "One port, three protocols", and "Implementation notes", "Public
// listener"): one TCP port that takes cleartext HTTP/2 and HTTP/1.1, told
// apart by the HTTP/2 client preface, and hands each request to the gateway.

import http from 'node:http';
import http2 from 'node:http2';
import net from 'node:net';
import type { Duplex } from 'node:stream';

/** The address of the public listener when `DORIC_HOST`/`DORIC_PORT` are unset. */
export const defaultPublicAddress = '0.0.0.0:3000';

/** The 24-byte client preface that opens every HTTP/2 connection. */
export const http2Preface = 'PRI * HTTP/2.0\r\n\r\nSM\r\n\r\n';

/**
 * How long a connection may take to send its first 24 bytes while each one
 * matches {@link http2Preface}; then it is closed.
 */
export const prefaceTimeoutMs = 10_000;

/**
 * The boot fails at the stage `public_binding`: the address is not
 * `<host>:<port>` (an IPv6 host in brackets, `[::]:3000`), or the listen
 * fails (the system error is the `cause`).
 */
export class PublicListenerBindingError extends Error {
  /** The boot stage the host reports the failure at. */
  readonly stage = 'public_binding';

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'PublicListenerBindingError';
  }
}

/** A request on either protocol, as `connectNodeAdapter`'s handler takes it. */
export type PublicRequestHandler = (
  request: http.IncomingMessage | http2.Http2ServerRequest,
  response: http.ServerResponse | http2.Http2ServerResponse,
) => void;

/** An HTTP/1.1 `upgrade` request, as `http.Server`'s `upgrade` event gives it. */
export type PublicUpgradeHandler = (
  request: http.IncomingMessage,
  socket: Duplex,
  head: Buffer,
) => void;

export interface PublicListenerOptions {
  /** `<host>:<port>`; port 0 binds a free port. Any host, loopback or not. */
  readonly address: string;
  /**
   * Every request, HTTP/2 or HTTP/1.1, but HTTP/1.1 `upgrade` requests.
   * Must not throw.
   */
  readonly request: PublicRequestHandler;
  /** Every HTTP/1.1 request with `Connection: upgrade`. Must not throw. */
  readonly upgrade: PublicUpgradeHandler;
  /** {@link prefaceTimeoutMs} when undefined; tests pass a shorter one. */
  readonly prefaceTimeoutMs?: number;
}

/** A bound public listener. */
export interface PublicListener {
  /** The bound port. */
  readonly port: number;
  /**
   * Stops listening and destroys every open connection, HTTP/2 sessions and
   * upgraded sockets included; resolves when the server is closed. A second
   * call resolves with the first.
   */
  close(): Promise<void>;
}

/**
 * Binds the public listener and resolves once it listens. Each accepted
 * connection is read until its bytes differ from {@link http2Preface} (an
 * HTTP/1.1 connection, served by an `http.Server`) or all 24 match (an
 * HTTP/2 connection, served by a cleartext `http2.Server`); the bytes read
 * are given back to the chosen server, so the request reaches `request` (or
 * `upgrade`) whole. A connection that sends fewer than 24 bytes, all
 * matching, within the preface timeout, or that closes first, is destroyed
 * without reaching either handler. Rejects with a
 * {@link PublicListenerBindingError} when the address is malformed or cannot
 * be bound; nothing is left listening then.
 */
export const startPublicListener = async (
  options: PublicListenerOptions,
): Promise<PublicListener> => {
  const { host, port } = parseAddress(options.address);
  const timeoutMs = options.prefaceTimeoutMs ?? prefaceTimeoutMs;
  const h1 = http.createServer(options.request);
  const h2 = http2.createServer(options.request);
  const sockets = new Set<net.Socket>();

  h1.on('upgrade', options.upgrade);
  h2.on('sessionError', () => {});
  h2.on('session', (session) => session.on('error', () => {}));

  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => {});
    sniff(socket, timeoutMs, (isHttp2) =>
      (isHttp2 ? h2 : h1).emit('connection', socket),
    );
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => {
      server.close();
      reject(
        new PublicListenerBindingError(
          `The public listener cannot listen on ${options.address}: ${error.message}`,
          { cause: error },
        ),
      );
    };

    server.once('error', onError);
    server.listen(port, host, () => {
      server.off('error', onError);
      resolve();
    });
  });

  const address = server.address();
  let closed: Promise<void> | undefined;

  return {
    port: typeof address === 'object' && address !== null ? address.port : port,
    close: () => {
      closed ??= new Promise<void>((resolve) => {
        server.close(() => resolve());

        for (const socket of sockets) {
          socket.destroy();
        }
      });

      return closed;
    },
  };
};

const preface = Buffer.from(http2Preface, 'latin1');

/**
 * Reads `socket` until its bytes differ from the preface or all of it
 * arrived, gives the bytes back and calls `hand` with the protocol; destroys
 * it at the preface timeout.
 */
const sniff = (
  socket: net.Socket,
  timeoutMs: number,
  hand: (isHttp2: boolean) => void,
): void => {
  let seen = Buffer.alloc(0);
  const timer = setTimeout(() => socket.destroy(), timeoutMs);
  const onData = (chunk: Buffer): void => {
    seen = Buffer.concat([seen, chunk]);

    const length = Math.min(seen.length, preface.length);
    const matches = seen
      .subarray(0, length)
      .equals(preface.subarray(0, length));

    if (matches && seen.length < preface.length) {
      return;
    }

    clearTimeout(timer);
    socket.off('data', onData);
    socket.pause();
    socket.unshift(seen);
    hand(matches);

    // The HTTP/2 session reads what is buffered itself; the HTTP/1.1 parser
    // waits for the socket to flow.
    if (!matches) {
      socket.resume();
    }
  };

  socket.on('data', onData);
  socket.on('close', () => clearTimeout(timer));
};

/** Splits `<host>:<port>` (`[::]:3000` for IPv6); throws a PublicListenerBindingError. */
const parseAddress = (address: string): { host: string; port: number } => {
  const match = /^(?:\[([^\]]+)\]|([^:[\]]+)):(\d{1,5})$/.exec(address);
  const host = match?.[1] ?? match?.[2];
  const port = Number(match?.[3]);

  if (host === undefined || !(port <= 65_535)) {
    throw new PublicListenerBindingError(
      `The public address ${address} is not <host>:<port>.`,
    );
  }

  return { host, port };
};
