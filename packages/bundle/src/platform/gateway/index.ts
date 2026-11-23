// The gateway (spec `docs/designs/grpc-processes.md`, section 11, "Gateway
// and public listener"): the public listener, the Connect router of the
// methods the gateway serves, relayed to the router, and the HTTP prefix
// proxy; rebuilt when the catalog changes.

import http from 'node:http';

import type { ResolvedEnvironment } from '../../runtime/catalog.js';
import type { CatalogIndex } from '../catalog-index.js';
import type { Router } from '../router/listener.js';
import {
  createGatewayHandler,
  type GatewayRelay,
  servedMethods,
} from './handler.js';
import { createPrefixProxy, httpPrefixesOf } from './prefix.js';
import { startPublicListener } from './public-listener.js';

export {
  createGatewayHandler,
  type GatewayHandlerOptions,
  type GatewayRelay,
  maxJsonRequestBytes,
  servedMethods,
} from './handler.js';
export {
  createPrefixProxy,
  httpPrefixesOf,
  type PrefixProxy,
  type PrefixProxyOptions,
} from './prefix.js';
export {
  defaultPublicAddress,
  http2Preface,
  type PublicListener,
  PublicListenerBindingError,
  type PublicListenerOptions,
  type PublicRequestHandler,
  type PublicUpgradeHandler,
  prefaceTimeoutMs,
  startPublicListener,
} from './public-listener.js';

export interface GatewayOptions {
  /** The public listener's address, `<host>:<port>`; port 0 binds a free port. */
  readonly address: string;
  /** The descriptors of every method the gateway may serve. */
  readonly index: CatalogIndex;
  /** The resolution served until the first {@link Gateway.setResolution}. */
  readonly resolved: ResolvedEnvironment;
  /** Where calls and prefixed requests go. */
  readonly router: Pick<
    Router,
    'serveGateway' | 'httpTargetOf' | 'trackConnection'
  >;
  /** `PublicListenerOptions.prefaceTimeoutMs`; tests pass a shorter one. */
  readonly prefaceTimeoutMs?: number;
}

/** A running gateway behind its public listener. */
export interface Gateway {
  /** The public listener's bound port. */
  readonly port: number;
  /**
   * Serves `next` from the next request on: the methods of
   * `servedMethods(index, next)` and the prefixes of `httpPrefixesOf(next)`.
   * A call or proxied connection already started finishes where it is,
   * whatever `next` holds. Never throws.
   */
  setResolution(next: ResolvedEnvironment): void;
  /**
   * Closes the public listener (`PublicListener.close`): later connections
   * are refused and open ones destroyed. A second call resolves with the
   * first.
   */
  close(): Promise<void>;
}

/**
 * Binds the public listener at `options.address` and serves, on its one
 * port:
 *
 * - HTTP/1.1 requests and upgrades under a prefix of the current resolution
 *   (`createPrefixProxy`);
 * - every other request, HTTP/2 or HTTP/1.1, through the handler of the
 *   current resolution's served methods (`createGatewayHandler`), each call
 *   relayed with `router.serveGateway` and the request's
 *   `doric-client-part`;
 * - an HTTP/1.1 upgrade under no prefix: `HTTP/1.1 404` written to the
 *   socket, then the socket destroyed.
 *
 * Resolves once it listens. Rejects with a `PublicListenerBindingError`
 * when the address is malformed or cannot be bound; nothing is left
 * listening then.
 */
export const startGateway = async (
  options: GatewayOptions,
): Promise<Gateway> => {
  const { index, router } = options;
  const relay: GatewayRelay = (request, clientPart) =>
    router.serveGateway(request, clientPart);
  const handlerOf = (resolved: ResolvedEnvironment) =>
    createGatewayHandler({
      index,
      methods: servedMethods(index, resolved),
      relay,
    });
  let handler = handlerOf(options.resolved);
  let prefixes = httpPrefixesOf(options.resolved);
  const proxy = createPrefixProxy({
    prefixes: () => prefixes,
    target: (bundleId) => router.httpTargetOf(bundleId),
    track: (key, cancel) => router.trackConnection(key, cancel),
  });
  const listener = await startPublicListener({
    address: options.address,
    request: (request, response) => {
      if (
        !(
          request instanceof http.IncomingMessage &&
          response instanceof http.ServerResponse &&
          proxy.request(request, response)
        )
      ) {
        handler(request, response);
      }
    },
    upgrade: (request, socket, head) => {
      if (!proxy.upgrade(request, socket, head)) {
        socket.on('error', () => {});
        socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n', () =>
          socket.destroy(),
        );
      }
    },
    ...(options.prefaceTimeoutMs === undefined
      ? {}
      : { prefaceTimeoutMs: options.prefaceTimeoutMs }),
  });

  return {
    port: listener.port,
    setResolution: (next) => {
      handler = handlerOf(next);
      prefixes = httpPrefixesOf(next);
    },
    close: () => listener.close(),
  };
};
