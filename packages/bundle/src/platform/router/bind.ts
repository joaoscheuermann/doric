// The router listener's socket (spec `docs/designs/grpc-processes.md`,
// section 2, "The router listener and the instance token"): cleartext
// HTTP/2 on a loopback address.

import http2 from 'node:http2';

/** The address the router binds when `DORIC_ROUTER_ADDRESS` is unset. */
export const defaultRouterAddress = '127.0.0.1:0';

/**
 * The boot fails at the stage `router_binding` (section 2): the address is
 * not `<host>:<port>` (an IPv6 host in brackets, `[::1]:0`), its host is not
 * `127.0.0.1` or `::1` (message `The router listens on loopback only.`), or
 * the listen fails (the system error is the `cause`).
 */
export class RouterBindingError extends Error {
  /** The boot stage the host reports the failure at. */
  readonly stage = 'router_binding';

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'RouterBindingError';
  }
}

const loopbackHosts: ReadonlySet<string> = new Set(['127.0.0.1', '::1']);

/** Splits `<host>:<port>` (`[::1]:0` for IPv6); throws a RouterBindingError. */
export const parseAddress = (
  address: string,
): { host: string; port: number } => {
  const match = /^(?:\[([^\]]+)\]|([^:[\]]+)):(\d{1,5})$/.exec(address);
  const host = match?.[1] ?? match?.[2];
  const port = Number(match?.[3]);

  if (host === undefined || !(port <= 65_535)) {
    throw new RouterBindingError(
      `The router address ${address} is not <host>:<port>.`,
    );
  }

  if (!loopbackHosts.has(host)) {
    throw new RouterBindingError('The router listens on loopback only.');
  }

  return { host, port };
};

/** A bound HTTP/2 server. */
export interface Bound {
  /** The bound port: the address's, or the one the system chose for 0. */
  readonly port: number;
  /** Stops listening, destroys every open session; resolves once closed. */
  close(): Promise<void>;
}

/**
 * Listens on `host:port` with `handler`; rejects with a
 * {@link RouterBindingError} naming `address` when the listen fails, leaving
 * nothing listening.
 */
export const listen = async (
  { host, port }: { readonly host: string; readonly port: number },
  address: string,
  handler: (
    request: http2.Http2ServerRequest,
    response: http2.Http2ServerResponse,
  ) => void,
): Promise<Bound> => {
  const server = http2.createServer(handler);
  const sessions = new Set<http2.ServerHttp2Session>();

  server.on('session', (session) => {
    sessions.add(session);
    session.on('close', () => sessions.delete(session));
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => {
      server.close();
      reject(
        new RouterBindingError(
          `The router cannot listen on ${address}: ${error.message}`,
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

  const bound = server.address();

  return {
    port: typeof bound === 'object' && bound !== null ? bound.port : port,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());

        for (const session of sessions) {
          session.destroy();
        }
      }),
  };
};
