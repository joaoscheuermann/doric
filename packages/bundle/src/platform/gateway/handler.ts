// The gateway's Connect router (spec `docs/designs/grpc-processes.md`,
// section 11, "One port, three protocols"): gRPC and the Connect protocol,
// binary and JSON, for the methods the gateway serves, each relayed to the
// router (`Router.serveGateway`) as a gRPC call; rebuilt when the catalog
// changes.

import type {
  DescMethod,
  DescMethodBiDiStreaming,
  DescMethodClientStreaming,
  DescMethodServerStreaming,
  DescMethodUnary,
} from '@bufbuild/protobuf';
import {
  Code,
  ConnectError,
  createConnectRouter,
  type HandlerContext,
  type Transport,
} from '@connectrpc/connect';
import {
  assertByteStreamRequest,
  createAsyncIterable,
  pipe,
  transformJoinEnvelopes,
  transformSplitEnvelope,
  type UniversalServerRequest,
  type UniversalServerResponse,
} from '@connectrpc/connect/protocol';
import { createTransport } from '@connectrpc/connect/protocol-grpc';
import {
  universalRequestFromNodeRequest,
  universalResponseToNodeResponse,
} from '@connectrpc/connect-node';

import { ContractError } from '../../contracts/error.js';
import { internalContracts } from '../../contracts/ids.js';
import {
  clientPartHeader,
  providerHeader,
  scopeHeader,
  targetHeader,
  traceparentHeader,
} from '../../contracts/metadata.js';
import { toConnectError } from '../../contracts/status.js';
import type { ResolvedEnvironment } from '../../runtime/catalog.js';
import type { CatalogIndex, MethodInfo } from '../catalog-index.js';
import { maxMessageBytes } from '../router/control.js';
import type { PublicRequestHandler } from './public-listener.js';

/**
 * The largest Connect JSON request message the gateway transcodes, in
 * bytes: today's body limit of the public API (`docs/features/host-api.md`),
 * so the host parses no larger JSON request than today (RK11).
 */
export const maxJsonRequestBytes = 102_400;

/**
 * Relays one call to the router: `Router.serveGateway`. `request` is a gRPC
 * request (`application/grpc+proto`, enveloped binary messages) on the
 * method's path; `clientPart` is the request's `doric-client-part`, or
 * undefined without one. Never rejects.
 */
export type GatewayRelay = (
  request: UniversalServerRequest,
  clientPart: string | undefined,
) => Promise<UniversalServerResponse>;

/**
 * The methods the gateway serves for `resolved` (section 11, "The routes"):
 * (a) every method of `index.publicMethods()` whose contract `resolved.contracts`
 * lists with at least one provider (the public API, `doric.api.*`, served to
 * any caller whatever its `expose`); then (b) every method of
 * `index.desktopMethods()`, in its order, whose service is a contract's own
 * (`role: 'contract'`), whose contract is a `HOST` contract that is not
 * `doric.*`, and that `resolved.contracts` lists with at least one provider;
 * a method in both appears once, at its (a) place. So a bundle a publish
 * adds has these methods served, and one it removes (or quarantines, or
 * disables) no longer has them, unless another provider remains; then (c)
 * every method of `platform` whose `expose` is `DESKTOP` (the platform
 * contracts the host serves in process: `doric.catalog/v1`'s `Get`,
 * `Distribution`, `ReadArtifact`, `Watch`, `Disable`, `ResetComposition`
 * and `doric.diagnostics/v1`'s `Report`), whatever `resolved` provides.
 * A method of `platform` that is not `DESKTOP` (`Descriptors`,
 * `doric.diagnostics/v1.Get`, `doric.generation/v1.*`) is never served.
 * Each path appears once, at its first place. Every other method is never
 * served. It never serves a method of `internalContracts`, whatever its
 * options. Pure; never throws.
 */
export const servedMethods = (
  index: CatalogIndex,
  resolved: ResolvedEnvironment,
  platform?: readonly MethodInfo[],
): readonly MethodInfo[] => {
  const provided = new Set(
    resolved.contracts
      .filter((contract) => contract.providers.length > 0)
      .map(({ id }) => id),
  );

  const publicApi = index
    .publicMethods()
    .filter(({ contract }) => provided.has(contract.id));
  const served = new Set(publicApi.map(({ path }) => path));
  const desktop = index
    .desktopMethods()
    .filter(
      ({ path, role, contract }) =>
        role === 'contract' &&
        contract.environment === 'HOST' &&
        !contract.id.startsWith('doric.') &&
        provided.has(contract.id) &&
        !served.has(path),
    );

  for (const { path } of desktop) {
    served.add(path);
  }

  const inProcess: MethodInfo[] = [];

  for (const info of platform ?? []) {
    if (info.expose === 'DESKTOP' && !served.has(info.path)) {
      served.add(info.path);
      inProcess.push(info);
    }
  }

  const internal = new Set<string>(internalContracts);

  return [...publicApi, ...desktop, ...inProcess].filter(
    ({ contract }) => !internal.has(contract.id),
  );
};

export interface GatewayHandlerOptions {
  /** The descriptors the JSON codec reads (`CatalogIndex.registry`). */
  readonly index: CatalogIndex;
  /** The methods to serve, as {@link servedMethods} answers them. */
  readonly methods: readonly MethodInfo[];
  readonly relay: GatewayRelay;
}

/**
 * A handler of the gateway's routes for one set of served methods; the
 * gateway builds a new one when the catalog changes, and a call already
 * started keeps the handler it started on. For a request:
 *
 * - a `content-type` starting with `application/grpc-web`: HTTP 415, the
 *   body unread (decision 28);
 * - the path `/<service full name>/<method name>` of a served method, over
 *   gRPC (HTTP/2) or the Connect protocol (unary and server streaming over
 *   either protocol version, client and bidirectional streaming over HTTP/2
 *   only), in binary or JSON: relayed. Each request message is encoded to
 *   binary with the method's descriptors and sent through `relay` with the
 *   request's `doric-client-part`, `doric-scope-bin`, `traceparent`,
 *   `doric-provider` and `doric-target` headers and its deadline as
 *   `grpc-timeout`; each response message comes back in the request's codec
 *   and the call ends with the relayed status, its `ContractError` reason
 *   kept (`toConnectError`). A JSON request message over
 *   {@link maxJsonRequestBytes} ends the call with `RESOURCE_EXHAUSTED`,
 *   reason `limit_exceeded`, before it is parsed; a binary message over 4
 *   MiB likewise (`maxMessageBytes`);
 * - the path of any other method: `UNIMPLEMENTED`, reason
 *   `unknown_contract`, in the request's protocol; nothing is relayed;
 * - any other path: HTTP 404.
 *
 * gRPC server reflection is not served. Never throws.
 */
export const createGatewayHandler = (
  options: GatewayHandlerOptions,
): PublicRequestHandler => {
  const router = createConnectRouter({
    grpc: true,
    connect: true,
    grpcWeb: false,
    jsonOptions: { registry: options.index.registry },
  });
  const served = new Set(options.methods.map(({ path }) => path));

  for (const info of options.methods) {
    serveMethod(router, info.method, options.relay);
  }

  for (const item of options.index.registry) {
    if (item.kind !== 'service') {
      continue;
    }

    for (const method of item.methods) {
      const path = `/${item.typeName}/${method.name}`;

      if (!served.has(path) && options.index.method(path) !== undefined) {
        serveMethod(router, method, undefined);
      }
    }
  }

  const handlers = new Map(
    router.handlers.map((handler) => [handler.requestPath, handler]),
  );

  return (request, response) => {
    const contentType = String(request.headers['content-type'] ?? '');
    const handler = handlers.get((request.url ?? '').split('?', 1)[0] ?? '');

    if (contentType.toLowerCase().startsWith('application/grpc-web')) {
      response.writeHead(415);
      response.end();

      return;
    }

    if (handler === undefined) {
      response.writeHead(404);
      response.end();

      return;
    }

    handler(
      limited(
        universalRequestFromNodeRequest(
          request,
          response,
          undefined,
          undefined,
        ),
      ),
    )
      .then((answer) => universalResponseToNodeResponse(answer, response))
      .catch(() => {
        // The caller is gone; the call has ended.
      });
  };
};

type ConnectRouter = ReturnType<typeof createConnectRouter>;

/** The method descriptor of each method kind. */
interface MethodOfKind {
  readonly unary: DescMethodUnary;
  readonly server_streaming: DescMethodServerStreaming;
  readonly client_streaming: DescMethodClientStreaming;
  readonly bidi_streaming: DescMethodBiDiStreaming;
}

const isKind = <K extends keyof MethodOfKind>(
  method: DescMethod,
  kind: K,
): method is MethodOfKind[K] => method.methodKind === kind;

/**
 * Registers `method` on `router`: each call relayed through `relay`, or,
 * without one, answered `UNIMPLEMENTED`, reason `unknown_contract`.
 */
const serveMethod = (
  router: ConnectRouter,
  method: DescMethod,
  relay: GatewayRelay | undefined,
): void => {
  const refuse = (): never => {
    throw toConnectError(
      new ContractError(
        'unknown_contract',
        `No contract serves /${method.parent.typeName}/${method.name}.`,
      ),
    );
  };

  if (isKind(method, 'unary')) {
    router.rpc(
      method,
      relay === undefined
        ? refuse
        : async (request, context) => {
            const call = relayedCall(relay, context);

            return (
              await call.transport.unary(
                method,
                call.signal,
                call.timeoutMs,
                call.header,
                request,
              )
            ).message;
          },
    );
  } else if (isKind(method, 'server_streaming')) {
    router.rpc(
      method,
      relay === undefined
        ? refuse
        : async function* (request, context) {
            const call = relayedCall(relay, context);

            yield* (
              await call.transport.stream(
                method,
                call.signal,
                call.timeoutMs,
                call.header,
                createAsyncIterable([request]),
              )
            ).message;
          },
    );
  } else if (isKind(method, 'client_streaming')) {
    router.rpc(
      method,
      relay === undefined
        ? refuse
        : async (requests, context) => {
            const call = relayedCall(relay, context);
            const answer = await call.transport.stream(
              method,
              call.signal,
              call.timeoutMs,
              call.header,
              requests,
            );

            for await (const message of answer.message) {
              return message;
            }

            throw new ConnectError(
              'The call ended without a response.',
              Code.Internal,
            );
          },
    );
  } else if (isKind(method, 'bidi_streaming')) {
    router.rpc(
      method,
      relay === undefined
        ? refuse
        : async function* (requests, context) {
            const call = relayedCall(relay, context);

            yield* (
              await call.transport.stream(
                method,
                call.signal,
                call.timeoutMs,
                call.header,
                requests,
              )
            ).message;
          },
    );
  }
};

/** The request headers a relayed call forwards. */
const forwardedHeaders = [
  scopeHeader,
  traceparentHeader,
  providerHeader,
  targetHeader,
] as const;

/**
 * A gRPC transport whose every request goes to `relay` with the call's
 * client part, and the call's signal, deadline and forwarded headers.
 */
const relayedCall = (
  relay: GatewayRelay,
  context: HandlerContext,
): {
  readonly transport: Transport;
  readonly signal: AbortSignal;
  readonly timeoutMs: number | undefined;
  readonly header: Headers;
} => {
  const clientPart = context.requestHeader.get(clientPartHeader) ?? undefined;
  const header = new Headers();

  for (const name of forwardedHeaders) {
    const value = context.requestHeader.get(name);

    if (value !== null) {
      header.set(name, value);
    }
  }

  return {
    transport: createTransport({
      httpClient: async (request) => {
        const signal = request.signal ?? context.signal;
        const answer = await relay(
          {
            httpVersion: '2.0',
            method: request.method,
            url: request.url,
            header: request.header,
            body: request.body ?? createAsyncIterable([]),
            signal,
          },
          clientPart,
        );

        return {
          status: answer.status,
          header: answer.header ?? new Headers(),
          body: answer.body ?? createAsyncIterable([]),
          // The relay fills its trailer as its body ends: kept, not copied.
          trailer: answer.trailer ?? new Headers(),
        };
      },
      baseUrl: 'http://gateway',
      useBinaryFormat: true,
      interceptors: [],
      acceptCompression: [],
      sendCompression: null,
      compressMinBytes: 0,
      readMaxBytes: maxMessageBytes,
      writeMaxBytes: maxMessageBytes,
    }),
    signal: context.signal,
    timeoutMs: context.timeoutMs(),
    header,
  };
};

/**
 * `request` with its body cut at the first request message over its limit:
 * {@link maxJsonRequestBytes} for JSON, `maxMessageBytes` for binary; the
 * call then ends with `RESOURCE_EXHAUSTED`, reason `limit_exceeded`.
 */
const limited = (request: UniversalServerRequest): UniversalServerRequest => {
  assertByteStreamRequest(request);

  const contentType = (request.header.get('content-type') ?? '').toLowerCase();
  const max = /^application\/((connect|grpc)\+)?json/.test(contentType)
    ? maxJsonRequestBytes
    : maxMessageBytes;

  return {
    ...request,
    body: /^application\/(grpc|connect\+)/.test(contentType)
      ? cappedEnvelopes(request.body, max)
      : capped(request.body, max),
  };
};

const tooLarge = (max: number): ConnectError =>
  toConnectError(
    new ContractError(
      'limit_exceeded',
      `A request message exceeds ${max} bytes.`,
    ),
  );

/** `body`, an unenveloped message, failing once it passes `max` bytes. */
async function* capped(
  body: AsyncIterable<Uint8Array>,
  max: number,
): AsyncGenerator<Uint8Array> {
  let total = 0;

  for await (const chunk of body) {
    total += chunk.byteLength;

    if (total > max) {
      throw tooLarge(max);
    }

    yield chunk;
  }
}

/** `body`, enveloped messages, failing at the first over `max` bytes. */
async function* cappedEnvelopes(
  body: AsyncIterable<Uint8Array>,
  max: number,
): AsyncGenerator<Uint8Array> {
  try {
    yield* pipe(body, transformSplitEnvelope(max), transformJoinEnvelopes());
  } catch (error) {
    throw error instanceof ConnectError && error.code === Code.ResourceExhausted
      ? tooLarge(max)
      : error;
  }
}
