// The transport of a client part (spec `docs/designs/grpc-processes.md`,
// section 10, `bundle/client`, and section 11, "The calling client part",
// D34): one Connect transport per client part, to the public listener, whose
// interceptor names the part in `doric-client-part`. Browser-safe: it reaches
// the network through `fetch`, never a `node:` module.

import {
  Code,
  ConnectError,
  type Interceptor,
  type Transport,
} from '@connectrpc/connect';
import {
  type UniversalClientFn,
  type UniversalClientRequest,
  universalClientResponseFromFetch,
  validateReadWriteMaxBytes,
} from '@connectrpc/connect/protocol';
import { createTransport } from '@connectrpc/connect/protocol-connect';

import { ContractError } from '../../contracts/error.js';
import {
  callerHeaderPrefix,
  clientPartHeader,
  maxMessageBytes,
} from '../../contracts/metadata.js';
import { fromConnectError, toConnectError } from '../../contracts/status.js';

/** What {@link createClientPartTransport} needs to know about its part. */
export interface ClientPartTransportOptions {
  /**
   * The bundle id of the client part that makes the calls, sent as
   * `doric-client-part` on every call (`clientPartHeader`,
   * `contracts/metadata.ts`).
   */
  readonly bundleId: string;
  /**
   * The public listener's base URL, `http://<host>:<port>` (`DORIC_HOST`,
   * `DORIC_PORT`, section 11), with or without a trailing slash. A method's
   * URL is `<baseUrl>/<package>.<Service>/<Method>`.
   */
  readonly baseUrl: string;
  /**
   * The `fetch` the transport calls; default `globalThis.fetch`, read when
   * a call starts. Tests and Electron may pass their own.
   */
  readonly fetch?: typeof globalThis.fetch;
}

/**
 * A Connect-protocol transport of one client part to the public listener:
 * binary Protobuf bodies, unary and server-streaming calls over whatever
 * HTTP version `fetch` uses. Creating it makes no call. Create one per
 * client part; every `use` of that part shares it. The Electron IPC
 * transport to Electron main that section 10 names comes in phases 3 to 5.
 *
 * Every call it carries has, whatever the caller's own call options set:
 *
 * - `doric-client-part: <bundleId>`, replacing a value the call options set;
 * - no header starting with `doric-caller`: the router stamps the caller.
 *
 * A request message whose binary form is over `maxMessageBytes`
 * (`contracts/metadata.ts`, 4 MiB, U20) is refused before it is sent: the
 * call fails with a `ConnectError` of code `RESOURCE_EXHAUSTED` whose Doric
 * code `fromConnectError` (`contracts/status.ts`) reads as
 * `limit_exceeded`. A message of exactly 4 MiB is sent.
 *
 * A call fails as the gateway, Electron main, the router or the provider
 * ends it, with a `ConnectError` whose Doric code `fromConnectError` reads
 * (`undeclared_requirement` for a contract the part did not declare,
 * `unavailable`, `generation_lost`, …); a network failure is a
 * `ConnectError` of code `UNAVAILABLE`.
 *
 * Throws a `TypeError`, creating nothing, when `bundleId` is empty or
 * `baseUrl` is not an absolute `http:` or `https:` URL.
 */
export const createClientPartTransport = (
  options: ClientPartTransportOptions,
): Transport => {
  if (options.bundleId === '') {
    throw new TypeError('The bundle id of a client part must not be empty.');
  }

  if (!isHttpUrl(options.baseUrl)) {
    throw new TypeError(
      `The base URL is not an absolute http or https URL: ${options.baseUrl}.`,
    );
  }

  const limits = validateReadWriteMaxBytes(
    undefined,
    maxMessageBytes,
    undefined,
  );

  return createTransport({
    httpClient: fetchClient((input, init) =>
      (options.fetch ?? globalThis.fetch)(input, init),
    ),
    baseUrl: options.baseUrl,
    useBinaryFormat: true,
    interceptors: [namePart(options.bundleId)],
    acceptCompression: [],
    sendCompression: null,
    ...limits,
  });
};

const isHttpUrl = (value: string): boolean => {
  try {
    const { protocol } = new URL(value);

    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
};

/**
 * Sets `doric-client-part: <bundleId>` and removes every `doric-caller*`
 * header; the call's other headers pass unchanged. A request over
 * `writeMaxBytes`, which Connect refuses with a `RESOURCE_EXHAUSTED` that
 * names no Doric code, fails with `limit_exceeded`.
 */
const namePart =
  (bundleId: string): Interceptor =>
  (next) =>
  async (request) => {
    const callers: string[] = [];

    request.header.forEach((_value, name) => {
      if (name.startsWith(callerHeaderPrefix)) {
        callers.push(name);
      }
    });

    for (const name of callers) {
      request.header.delete(name);
    }

    request.header.set(clientPartHeader, bundleId);

    try {
      return await next(request);
    } catch (error) {
      if (
        error instanceof ConnectError &&
        error.code === Code.ResourceExhausted &&
        fromConnectError(error).code === 'internal'
      ) {
        throw toConnectError(
          new ContractError('limit_exceeded', error.rawMessage),
        );
      }

      throw error;
    }
  };

/**
 * The HTTP client of the transport over `fetch`. The request body, one
 * message for the unary and server-streaming calls it carries, is sent
 * whole: `fetch` refuses a streamed body without `duplex`, and browsers
 * stream request bodies only over HTTP/2. A `fetch` that fails while the
 * call was not aborted is a network failure: `UNAVAILABLE`.
 */
const fetchClient =
  (fetch: typeof globalThis.fetch): UniversalClientFn =>
  async (request) => {
    const body = await bodyOf(request);
    let response: Response;

    try {
      response = await fetch(request.url, {
        method: request.method,
        headers: request.header,
        ...(body === undefined ? {} : { body }),
        ...(request.signal === undefined ? {} : { signal: request.signal }),
      });
    } catch (error) {
      if (request.signal?.aborted === true || error instanceof ConnectError) {
        throw error;
      }

      throw toConnectError(
        new ContractError(
          'unavailable',
          error instanceof Error ? error.message : String(error),
        ),
      );
    }

    return universalClientResponseFromFetch(response);
  };

/** The bytes of `request`'s body, `undefined` without one. */
const bodyOf = async (
  request: UniversalClientRequest,
): Promise<Uint8Array<ArrayBuffer> | undefined> => {
  if (request.body === undefined) {
    return undefined;
  }

  const chunks: Uint8Array[] = [];
  let length = 0;

  for await (const chunk of request.body) {
    chunks.push(chunk);
    length += chunk.byteLength;
  }

  const bytes = new Uint8Array(length);
  let offset = 0;

  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return bytes;
};
