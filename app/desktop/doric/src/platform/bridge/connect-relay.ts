// `doric:connect` (spec `docs/designs/grpc-processes.md`, section 13, "The
// window to main"): a window's Connect requests to the host, checked here and
// forwarded with their bytes unchanged. Main decodes only `doric-scope-bin`;
// it no longer validates payloads against JSON Schemas.

import {
  codeToHttpStatus,
  endStreamFlag,
  endStreamToJson,
  errorToJsonBytes,
} from '@connectrpc/connect/protocol-connect';
import {
  type CallScope,
  ContractError,
  callerHeaderPrefix,
  clientPartHeader,
  isContractError,
  isPlatformContract,
  scopeFromHeader,
  scopeHeader,
  scopeHeaderValue,
  toConnectError,
  windowScopeKey,
} from 'bundle/contracts';
import type { CatalogIndex } from 'bundle/platform';
import {
  CONNECT_CHANNEL,
  type ConnectAnswer,
  type ConnectHeaders,
  connectRequestSchema,
} from 'desktop/protocol';

import type { WindowRegistry } from '../windows/registry';
import { clientPartOf, type GenerationView } from './client-routing';
import type { DesktopEvent } from './dispatcher';
import { isShellSender, SENDER_REFUSED_MESSAGE } from './sender';

/** One Connect request main forwards to the host. */
export interface ForwardRequest {
  /** `/<package>.<Service>/<Method>`. */
  readonly path: string;
  readonly headers: ConnectHeaders;
  readonly body: Uint8Array;
}

/** The host's response: its HTTP status, headers and body, in order. */
export interface ForwardResponse {
  readonly status: number;
  readonly headers: ConnectHeaders;
  readonly body: AsyncIterable<Uint8Array>;
}

/** Forwards one Connect request to the host, bytes unchanged. */
export interface HostForward {
  /**
   * Sends `input` to the host's public listener. Rejects when the host is
   * not reached; `signal` aborting cancels the request.
   */
  request(input: ForwardRequest, signal: AbortSignal): Promise<ForwardResponse>;
}

/** What Electron hands the `doric:connect` listener. */
export interface ConnectEvent extends DesktopEvent {
  readonly sender: DesktopEvent['sender'] & {
    /** `webContents.postMessage`: how main hands a stream's port over. */
    postMessage(channel: string, message: unknown, transfer?: unknown[]): void;
  };
}

export interface ConnectRelayDeps {
  readonly registry: WindowRegistry;
  /** The view of a generation main resolved, by number. */
  readonly view: (generation: number) => GenerationView | undefined;
  /**
   * The index of a generation's distributed `descriptors.binpb` files
   * (`catalogIndexFromDescriptors`), by number; undefined when main has
   * none for it.
   */
  readonly index: (generation: number) => CatalogIndex | undefined;
  readonly forward: HostForward;
}

export interface ConnectRelay {
  /** The `ipcMain.handle('doric:connect')` listener. */
  handle(event: ConnectEvent, raw: unknown): Promise<ConnectAnswer>;
}

/**
 * `ipcMain.handle('doric:connect')`: checks the sender as `doric:desktop`
 * does (a refused sender rejects with `SENDER_REFUSED_MESSAGE`, as there) and
 * the window's pinned generation; `doric-client-part` absent →
 * `PERMISSION_DENIED` `undeclared_requirement`; naming no active client part
 * of that generation → `UNAVAILABLE` `unavailable`; a path that is not a
 * `DESKTOP` method of a `HOST`, non-`doric.*` contract of the generation's
 * index → `UNIMPLEMENTED` `unknown_contract`; otherwise sets `windowKey` in
 * `doric-scope-bin` (replacing the window's), drops `doric-caller*`, and
 * forwards. A unary answer comes back whole; a stream's body goes on a
 * `MessagePort` main posts to the sender. Every refusal past the sender
 * check, and a host that is not reached (`UNAVAILABLE` `unavailable`), is a
 * Connect-protocol error answer, so the window's client reads its Doric code
 * with `fromConnectError`.
 */
export const createConnectRelay = (deps: ConnectRelayDeps): ConnectRelay => {
  let streams = 0;

  return {
    handle: async (event, raw) => {
      const entry = deps.registry.byWebContents(event.sender.id);

      if (
        !isShellSender(event.senderFrame?.url) ||
        entry === undefined ||
        (event.sender.mainFrame !== undefined &&
          event.senderFrame !== event.sender.mainFrame &&
          event.senderFrame !== undefined)
      ) {
        throw new Error(SENDER_REFUSED_MESSAGE);
      }

      const parsed = connectRequestSchema.safeParse(raw);
      const streaming =
        parsed.success &&
        (headerOf(parsed.data.headers, 'content-type') ?? '').startsWith(
          'application/connect+',
        );

      try {
        if (!parsed.success) {
          throw new ContractError(
            'invalid_input',
            `Invalid Connect request: ${parsed.error.message}`,
          );
        }

        const request = parsed.data;
        const bundleId = headerOf(request.headers, clientPartHeader);

        if (bundleId === undefined || bundleId === '') {
          throw new ContractError(
            'undeclared_requirement',
            `A request without ${clientPartHeader} names no client part.`,
          );
        }

        const generation = entry.pinnedGeneration;
        const view = generation === null ? undefined : deps.view(generation);

        if (
          generation === null ||
          view === undefined ||
          clientPartOf(view, bundleId) === undefined
        ) {
          throw new ContractError(
            'unavailable',
            `"${bundleId}" has no active client part in the window's generation.`,
          );
        }

        const method = deps.index(generation)?.method(request.path);

        if (
          method === undefined ||
          method.expose !== 'DESKTOP' ||
          method.contract.environment !== 'HOST' ||
          isPlatformContract(method.contract.id)
        ) {
          throw new ContractError(
            'unknown_contract',
            `${request.path} is not a method the desktop may call.`,
          );
        }

        const headers = forwardHeaders(request.headers, entry.key);
        const controller = new AbortController();
        let response: ForwardResponse;

        try {
          response = await deps.forward.request(
            { path: request.path, headers, body: request.body },
            controller.signal,
          );
        } catch (error) {
          throw new ContractError(
            'unavailable',
            `The host was not reached: ${error instanceof Error ? error.message : String(error)}`,
          );
        }

        if (
          !(headerOf(response.headers, 'content-type') ?? '').startsWith(
            'application/connect+',
          )
        ) {
          return {
            status: response.status,
            headers: response.headers,
            body: await collect(response.body),
          };
        }

        streams += 1;

        const stream = `${event.sender.id}:${streams}`;

        await handOver(event, stream, response.body, controller);

        return { status: response.status, headers: response.headers, stream };
      } catch (error) {
        return errorAnswer(error, streaming);
      }
    },
  };
};

const headerOf = (headers: ConnectHeaders, name: string): string | undefined =>
  headers.find(([key]) => key.toLowerCase() === name)?.[1];

/**
 * The window's headers without `doric-caller*`, with `windowKey` in
 * `doric-scope-bin` set to `windowKey`. A `doric-scope-bin` that is not a
 * valid scope throws `invalid_scope`.
 */
const forwardHeaders = (
  headers: ConnectHeaders,
  windowKey: string,
): ConnectHeaders => {
  const sent = headerOf(headers, scopeHeader);
  const scope: CallScope = {
    ...(sent === undefined ? {} : scopeFromHeader(sent)),
    [windowScopeKey]: windowKey,
  };

  return [
    ...headers.filter(([name]) => {
      const lower = name.toLowerCase();

      return !lower.startsWith(callerHeaderPrefix) && lower !== scopeHeader;
    }),
    [scopeHeader, scopeHeaderValue(scope)],
  ];
};

const collect = async (
  body: AsyncIterable<Uint8Array>,
): Promise<Uint8Array> => {
  const chunks: Uint8Array[] = [];
  let length = 0;

  for await (const chunk of body) {
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

/**
 * Sends the window a `MessagePortMain` on {@link CONNECT_CHANNEL} with the
 * id `stream`, and posts each chunk of `body` on it, then `null`. The window
 * closing its end aborts the request.
 */
const handOver = async (
  event: ConnectEvent,
  stream: string,
  body: AsyncIterable<Uint8Array>,
  controller: AbortController,
): Promise<void> => {
  const { MessageChannelMain } = await import('electron');
  const { port1, port2 } = new MessageChannelMain();
  let open = true;

  port1.on('close', () => {
    open = false;
    controller.abort();
  });
  port1.start();
  event.sender.postMessage(CONNECT_CHANNEL, { stream }, [port2]);
  void (async () => {
    try {
      for await (const chunk of body) {
        if (!open) {
          return;
        }

        port1.postMessage(chunk);
      }
    } catch {
      // A body cut short: closing the port tells the window.
      open = false;
      port1.close();

      return;
    }

    if (open) {
      port1.postMessage(null);
    }
  })();
};

/** A refusal as a Connect-protocol error answer, unary or streaming. */
const errorAnswer = (error: unknown, streaming: boolean): ConnectAnswer => {
  const failure = toConnectError(
    isContractError(error)
      ? error
      : new ContractError(
          'internal',
          error instanceof Error ? error.message : String(error),
        ),
  );

  if (!streaming) {
    return {
      status: codeToHttpStatus(failure.code),
      headers: [['content-type', 'application/json']],
      body: errorToJsonBytes(failure, undefined),
    };
  }

  const json = new TextEncoder().encode(
    JSON.stringify(endStreamToJson(new Headers(), failure, undefined)),
  );
  const body = new Uint8Array(5 + json.byteLength);

  body[0] = endStreamFlag;
  new DataView(body.buffer).setUint32(1, json.byteLength);
  body.set(json, 5);

  return {
    status: 200,
    headers: [['content-type', 'application/connect+proto']],
    body,
  };
};
