// The gateway (spec `docs/designs/grpc-processes.md`, section 11, "Gateway
// and public listener"): the public listener, the Connect router of the
// methods the gateway serves, relayed to the router, and the HTTP prefix
// proxy; rebuilt when the catalog changes.

import http from 'node:http';

import {
  create,
  createFileRegistry,
  type DescFile,
  type FileRegistry,
} from '@bufbuild/protobuf';
import { FileDescriptorSetSchema } from '@bufbuild/protobuf/wkt';

import type { ResolvedEnvironment } from '../../runtime/catalog.js';
import type { CatalogIndex, MethodInfo } from '../catalog-index.js';
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
  /**
   * The methods of the platform services served in process (`startPlatform`'s
   * platform index), passed to `servedMethods` as `platform` at start and at
   * each `setResolution`; their files join the JSON codec's registry, so a
   * Connect JSON request to them transcodes. Empty when undefined.
   */
  readonly platformMethods?: readonly MethodInfo[];
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
  const { router } = options;
  const platform = options.platformMethods ?? [];
  const index = withMethods(options.index, platform);
  const relay: GatewayRelay = (request, clientPart) =>
    router.serveGateway(request, clientPart);
  const handlerOf = (resolved: ResolvedEnvironment) =>
    createGatewayHandler({
      index,
      methods: servedMethods(options.index, resolved, platform),
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

/**
 * `index`, falling back to `methods` by path, with the files of `methods`'
 * services (and the files they import) in its registry, so the gateway's
 * JSON codec reads them and their methods that are not served answer
 * `UNIMPLEMENTED`. A file of `index` wins over one of the same name.
 */
const withMethods = (
  index: CatalogIndex,
  methods: readonly MethodInfo[],
): CatalogIndex => {
  if (methods.length === 0) {
    return index;
  }

  const byPath = new Map(methods.map((info) => [info.path, info]));

  return {
    method: (path) => index.method(path) ?? byPath.get(path),
    service: (fullName) => index.service(fullName),
    contract: (id) => index.contract(id),
    desktopMethods: () => index.desktopMethods(),
    publicMethods: () => index.publicMethods(),
    registry: createFileRegistry(
      registryOf(methods.map(({ service }) => service.file)),
      index.registry,
    ),
  };
};

/**
 * The registry of `files` and every file they import, each name once,
 * imports first.
 */
const registryOf = (files: readonly DescFile[]): FileRegistry => {
  const seen = new Set<string>();
  const ordered: DescFile[] = [];
  const visit = (file: DescFile): void => {
    if (seen.has(file.proto.name)) {
      return;
    }

    seen.add(file.proto.name);

    for (const dependency of file.dependencies) {
      visit(dependency);
    }

    ordered.push(file);
  };

  for (const file of files) {
    visit(file);
  }

  return createFileRegistry(
    create(FileDescriptorSetSchema, {
      file: ordered.map(({ proto }) => proto),
    }),
  );
};
