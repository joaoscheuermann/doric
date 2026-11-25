// The window's Connect path to the host (phase 3; spec
// `docs/designs/grpc-processes.md`, section 13, "The window to main"): a
// `fetch` that carries Connect requests over `doric:connect`, and the
// `HostClients` a window's runtime answers `services.use` of a generated
// descriptor with. Browser-safe.

import { type ClientPart, createClientPart } from 'bundle/client';
import { ContractError, toConnectError } from 'bundle/contracts';
import type { HostClients } from 'bundle/runtime';

import type {
  ConnectHeaders,
  ConnectPort,
  DoricConnectApi,
  WindowCatalog,
} from './protocol.js';

/**
 * The base URL of a window's client parts: never dialled, main relays each
 * request by its path. An absolute `http:` URL, as `createClientPartTransport`
 * requires.
 */
export const WINDOW_HOST_URL = 'http://doric.window';

/**
 * A `fetch` that sends each Connect request through `api` on
 * `doric:connect`: the request's path (from its URL), headers and body.
 * A unary call answers its whole response; a streaming call's response body
 * reads the port of the reply in order and ends at its `null`; a port that
 * closes before it ends the call with `UNAVAILABLE`. `init.signal` aborting
 * closes the port. A rejection of `api.request` (a dead channel) is a
 * `TypeError`, which Connect reads as `UNAVAILABLE`.
 */
export const windowFetch =
  (api: DoricConnectApi): typeof fetch =>
  async (input, init) => {
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    const headers: [string, string][] = [];

    new Headers(init?.headers).forEach((value, name) => {
      headers.push([name, value]);
    });

    const body =
      init?.body === undefined || init.body === null
        ? new Uint8Array()
        : new Uint8Array(await new Response(init.body).arrayBuffer());
    let reply: Awaited<ReturnType<DoricConnectApi['request']>>;

    try {
      reply = await api.request({ path: new URL(url).pathname, headers, body });
    } catch (error) {
      throw new TypeError(
        `doric:connect failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    const responseInit = {
      status: reply.status,
      headers: headersOf(reply.headers),
    };

    if ('body' in reply) {
      return new Response(reply.body as Uint8Array<ArrayBuffer>, responseInit);
    }

    return new Response(
      bodyOverPort(reply.port, init?.signal ?? undefined),
      responseInit,
    );
  };

const headersOf = (pairs: ConnectHeaders): Headers => {
  const headers = new Headers();

  for (const [name, value] of pairs) {
    headers.append(name, value);
  }

  return headers;
};

/**
 * A response body read from `port`: each `Uint8Array` message a chunk, `null`
 * its end; a port closing before `null` errors the body with `UNAVAILABLE`.
 * Cancelling the body or `signal` aborting closes the port.
 */
const bodyOverPort = (
  port: ConnectPort,
  signal: AbortSignal | undefined,
): ReadableStream<Uint8Array> => {
  let done = false;

  return new ReadableStream<Uint8Array>({
    start: (controller) => {
      const finish = (error?: unknown) => {
        if (done) {
          return;
        }

        done = true;
        port.close();

        if (error === undefined) {
          controller.close();
        } else {
          controller.error(error);
        }
      };

      port.addEventListener('message', ({ data }) => {
        if (done) {
          return;
        }

        if (data === null) {
          finish();
        } else if (data instanceof Uint8Array) {
          controller.enqueue(data);
        }
      });
      port.addEventListener('close', () =>
        finish(
          toConnectError(
            new ContractError(
              'unavailable',
              'The stream from the host ended before its end.',
            ),
          ),
        ),
      );
      signal?.addEventListener('abort', () => finish(signal.reason), {
        once: true,
      });
      port.start();
    },
    cancel: () => {
      done = true;
      port.close();
    },
  });
};

/**
 * The window's host clients: one `createClientPart({ bundleId, baseUrl:
 * WINDOW_HOST_URL, fetch: windowFetch(api) })` per bundle id, made on first
 * use; `provider` answers `catalog.hostProviders`.
 */
export const windowHostClients = (
  api: DoricConnectApi,
  catalog: WindowCatalog,
): HostClients => {
  const fetch = windowFetch(api);
  const parts = new Map<string, ClientPart>();

  return {
    part: (bundleId) => {
      let part = parts.get(bundleId);

      if (part === undefined) {
        part = createClientPart({ bundleId, baseUrl: WINDOW_HOST_URL, fetch });
        parts.set(bundleId, part);
      }

      return part;
    },
    provider: (contractId) => catalog.hostProviders?.[contractId],
  };
};
