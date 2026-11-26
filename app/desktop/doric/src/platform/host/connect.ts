// Electron main's one Connect connection to the host (spec
// `docs/designs/grpc-processes.md`, section 13, "Electron main to the host"):
// the `api.status/v1` watch that *is* the connection status, its retries, the
// two ways of hearing about them, and the forward a window's Connect stream
// travels on. Every call main makes and every window stream it relays share
// this one HTTP/2 session.

import {
  type ClientHttp2Stream,
  constants,
  type IncomingHttpHeaders,
  type OutgoingHttpHeaders,
} from 'node:http2';

import { createClient, type Transport } from '@connectrpc/connect';
import { createConnectTransport, Http2SessionManager } from '@connectrpc/connect-node';
import { ContractError } from 'bundle/contracts';
import { StatusService } from 'transport/contracts/gen/doric/api/status/v1/status_pb.js';

import type {
  ForwardRequest,
  ForwardResponse,
  HostForward,
} from '../bridge/connect-relay';
import { messageOf } from '../log';

/** The host origin on the app's own loopback, unless `DORIC_HOST_URL` says otherwise. */
export const HOST_URL = 'http://127.0.0.1:3000';

/** How long main waits before opening the status watch again. */
export const CONNECTION_RETRY_MS = 1_000;

export type ConnectionStatus = 'connected' | 'disconnected';

export type ConnectionListener = (status: ConnectionStatus) => void;

/** What `doric.connection/v1` (and anything else) reads of the connection. */
export interface ConnectionSource {
  status(): ConnectionStatus;
  subscribe(listener: ConnectionListener): () => void;
}

/** One status outcome of one attempt: its first item, or its end or failure. */
export interface ConnectionStatusEvent {
  readonly connected: boolean;
  /** Why the attempt failed, for a person; absent for a clean end. */
  readonly error?: string;
}

export interface HostConnection extends ConnectionSource {
  readonly url: string;
  readonly connected: boolean;
  /** The transport main's own calls travel on. */
  readonly transport: Transport;
  /** The forward a window's Connect request travels on. */
  readonly forward: HostForward;
  /** Every attempt's outcome, not only changes of {@link status}. */
  onStatus(listener: (status: ConnectionStatusEvent) => void): () => void;
  /** Closes the current watch and opens a new one at once (splash Retry). */
  retry(): void;
  close(): void;
}

/** Headers HTTP/2 refuses, or that `node:http2` sets itself. */
const http2Refused = new Set([
  'connection',
  'host',
  'keep-alive',
  'proxy-connection',
  'transfer-encoding',
  'upgrade',
  'content-length',
]);

/** The response's headers as Connect header pairs. */
const pairsOf = (headers: IncomingHttpHeaders): [string, string][] => {
  const pairs: [string, string][] = [];

  for (const [name, value] of Object.entries(headers)) {
    if (name.startsWith(':') || value === undefined) {
      continue;
    }

    for (const one of Array.isArray(value) ? value : [value]) {
      pairs.push([name, String(one)]);
    }
  }

  return pairs;
};

/** `stream`'s bytes, telling the session manager each read keeps it alive. */
async function* bodyOf(
  stream: ClientHttp2Stream,
  session: Http2SessionManager,
): AsyncGenerator<Uint8Array> {
  for await (const chunk of stream) {
    session.notifyResponseByteRead(stream);

    yield chunk;
  }
}

/**
 * Opens main's Connect connection to `options.url`: one HTTP/2 session for
 * main's own calls and for the forward a window's stream travels on, and the
 * `StatusService.Watch` that reads `connected` after its first item and
 * `disconnected` when it ends. An ended or failed watch reopens after
 * {@link CONNECTION_RETRY_MS}.
 */
export const connectHost = (options: {
  readonly url: string;
  readonly transport?: Transport;
}): HostConnection => {
  const url = options.url;
  const session = new Http2SessionManager(url);
  const transport =
    options.transport ??
    createConnectTransport({
      baseUrl: url,
      httpVersion: '2',
      useBinaryFormat: true,
      sessionManager: session,
    });
  const client = createClient(StatusService, transport);

  let current: ConnectionStatus = 'disconnected';
  let closed = false;
  let controller: AbortController | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const changes = new Set<ConnectionListener>();
  const outcomes = new Set<(status: ConnectionStatusEvent) => void>();

  const publish = (status: ConnectionStatus): void => {
    if (closed || current === status) {
      return;
    }

    current = status;

    for (const listener of [...changes]) {
      listener(status);
    }
  };

  const report = (status: ConnectionStatusEvent): void => {
    for (const listener of [...outcomes]) {
      listener(status);
    }
  };

  const clearTimer = (): void => {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
  };

  const schedule = (): void => {
    clearTimer();

    if (closed) {
      return;
    }

    timer = setTimeout(() => {
      timer = undefined;
      open();
    }, CONNECTION_RETRY_MS);
  };

  const watch = async (signal: AbortSignal): Promise<void> => {
    let connected = false;
    let error: unknown;

    try {
      for await (const _ of client.watch({}, { signal })) {
        void _;

        if (!connected) {
          connected = true;
          publish('connected');
          report({ connected: true });
        }
      }
    } catch (cause) {
      error = cause;
    }

    // A watch `retry` or `close` replaced is not an outcome of the connection.
    if (closed || controller?.signal !== signal) {
      return;
    }

    controller = undefined;
    publish('disconnected');
    report({
      connected: false,
      ...(error === undefined ? {} : { error: messageOf(error) }),
    });
    schedule();
  };

  const open = (): void => {
    if (closed) {
      return;
    }

    clearTimer();

    const previous = controller;
    const next = new AbortController();

    controller = next;
    previous?.abort();
    void watch(next.signal);
  };

  const forward: HostForward = {
    request: async (
      input: ForwardRequest,
      signal: AbortSignal,
    ): Promise<ForwardResponse> => {
      if (closed || current !== 'connected') {
        throw new ContractError('unavailable', 'The host is not connected.');
      }

      const headers: OutgoingHttpHeaders = {};

      for (const [name, value] of input.headers) {
        if (!http2Refused.has(name.toLowerCase())) {
          headers[name.toLowerCase()] = value;
        }
      }

      let stream: ClientHttp2Stream;

      try {
        stream = await session.request('POST', input.path, headers, {});

        if (input.body.byteLength > 0) {
          stream.end(input.body);
        } else {
          stream.end();
        }
      } catch (error) {
        throw new ContractError('unavailable', messageOf(error));
      }

      const cancel = (): void => {
        stream.close(constants.NGHTTP2_CANCEL);
        stream.destroy();
      };

      signal.addEventListener('abort', cancel, { once: true });
      stream.once('close', () => signal.removeEventListener('abort', cancel));

      let response: IncomingHttpHeaders;

      try {
        response = await new Promise<IncomingHttpHeaders>((resolve, reject) => {
          stream.once('response', resolve);
          stream.once('error', reject);
        });
      } catch (error) {
        throw new ContractError('unavailable', messageOf(error));
      }

      return {
        status: Number(response[':status'] ?? 0),
        headers: pairsOf(response),
        body: bodyOf(stream, session),
      };
    },
  };

  open();

  return {
    url,
    get connected() {
      return current === 'connected';
    },
    transport,
    forward,
    status: () => current,
    subscribe: (listener) => {
      if (closed) {
        return () => undefined;
      }

      changes.add(listener);

      return () => {
        changes.delete(listener);
      };
    },
    onStatus: (listener) => {
      if (closed) {
        return () => undefined;
      }

      outcomes.add(listener);

      return () => {
        outcomes.delete(listener);
      };
    },
    retry: () => {
      open();
    },
    close: () => {
      if (closed) {
        return;
      }

      clearTimer();

      const active = controller;

      controller = undefined;
      publish('disconnected');
      closed = true;
      changes.clear();
      outcomes.clear();
      active?.abort();
      session.abort();
    },
  };
};
