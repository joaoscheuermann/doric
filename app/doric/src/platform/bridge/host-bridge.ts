// The desktop end of the host bridge (`/doric/bridge`, HR-1): calls and
// streams to host services as envelope messages over Socket.IO. Each message
// is emitted under its `kind` (`call`, `cancel`, `subscribe`, `unsubscribe`;
// the host answers `result`, `event` and `end`) and carries the whole
// envelope message, `kind` included.

import { ContractError } from 'bundle/contracts';
import type {
  CallMessage,
  EndMessage,
  EventMessage,
  ResultMessage,
  SubscribeMessage,
  WireCall,
  WireError,
} from 'bundle/runtime';
import { io, type Socket } from 'socket.io-client';

/** The text the REST client answers today for network failures and its timeout. */
export const HOST_UNAVAILABLE_MESSAGE = 'Doric backend is unavailable.';

export const hostUnavailable = (): ContractError =>
  new ContractError('unavailable', HOST_UNAVAILABLE_MESSAGE);

export const BRIDGE_NAMESPACE = '/doric/bridge';
/** = today's `connectionPollMs` (P4). */
export const CONNECTION_RETRY_MS = 1_000;

export interface StreamSink {
  event(values: readonly unknown[]): void;
  end(error?: ContractError): void;
}

export type BridgeStatus =
  | { readonly connected: true }
  | { readonly connected: false; readonly error?: string };

export interface HostBridge {
  readonly connected: boolean;
  onStatus(listener: (status: BridgeStatus) => void): () => void;
  call(
    target: {
      readonly contract: string;
      readonly method: string;
      readonly input: unknown;
    },
    wire: WireCall,
    signal?: AbortSignal,
  ): Promise<unknown>;
  subscribe(
    target: {
      readonly contract: string;
      readonly method: string;
      readonly input: unknown;
    },
    wire: WireCall,
    sink: StreamSink,
  ): () => void;
  /** An immediate connection attempt (splash Retry). */
  retry(): void;
  close(): void;
}

export const errorOf = (error: WireError): ContractError =>
  new ContractError(error.code, error.message, error.details);

/** The socket seam: Socket.IO in the app, an in-memory pair in tests. */
export interface BridgeSocket {
  readonly connected: boolean;
  /**
   * Socket.IO's `active`: false once the server refused the connection
   * itself (a namespace middleware), which Socket.IO does not retry.
   */
  readonly active?: boolean;
  on(event: string, listener: (...args: never[]) => void): void;
  emit(event: string, message: unknown): void;
  connect(): void;
  disconnect(): void;
}

export const connectBridgeSocket = (hostUrl: string): BridgeSocket =>
  io(`${hostUrl.replace(/\/+$/, '')}${BRIDGE_NAMESPACE}`, {
    transports: ['websocket'],
    reconnection: true,
    reconnectionDelay: CONNECTION_RETRY_MS,
    reconnectionDelayMax: CONNECTION_RETRY_MS,
    randomizationFactor: 0,
  }) as Socket as unknown as BridgeSocket;

export const createHostBridge = (
  socket: BridgeSocket,
  options: { readonly now?: () => number } = {},
): HostBridge => {
  const now = options.now ?? Date.now;
  let counter = 0;
  let closed = false;
  const pending = new Map<
    string,
    {
      readonly resolve: (output: unknown) => void;
      readonly reject: (error: unknown) => void;
    }
  >();
  const streams = new Map<string, StreamSink>();
  const listeners = new Set<(status: BridgeStatus) => void>();
  const nextId = (prefix: string) => {
    counter += 1;

    return `d:${prefix}${counter}`;
  };
  const publish = (status: BridgeStatus) => {
    for (const listener of [...listeners]) {
      listener(status);
    }
  };
  const lost = () => {
    for (const [id, waiting] of [...pending]) {
      pending.delete(id);
      waiting.reject(hostUnavailable());
    }

    for (const [id, sink] of [...streams]) {
      streams.delete(id);
      sink.end(
        new ContractError('disconnected', 'The host bridge disconnected.'),
      );
    }
  };

  socket.on('connect', () => publish({ connected: true }));
  socket.on('disconnect', () => {
    lost();
    publish({ connected: false });
  });
  socket.on('connect_error', ((error: Error) => {
    publish({ connected: false, error: error.message });

    // Socket.IO retries a transport failure on its own; a refusal by the
    // server it does not, and the desktop keeps trying every second (P4).
    if (socket.active === false && !closed) {
      setTimeout(() => {
        if (!closed && !socket.connected) {
          socket.connect();
        }
      }, CONNECTION_RETRY_MS);
    }
  }) as (...args: never[]) => void);
  socket.on('result', ((message: ResultMessage) => {
    const waiting = pending.get(message?.id);

    if (waiting === undefined) {
      return;
    }

    pending.delete(message.id);

    if (message.ok) {
      waiting.resolve(message.output);
    } else {
      waiting.reject(errorOf(message.error));
    }
  }) as (...args: never[]) => void);
  socket.on('event', ((message: EventMessage) => {
    streams.get(message?.id)?.event(message.values ?? []);
  }) as (...args: never[]) => void);
  socket.on('end', ((message: EndMessage) => {
    const sink = streams.get(message?.id);

    if (sink !== undefined) {
      streams.delete(message.id);
      sink.end(
        message.error === undefined ? undefined : errorOf(message.error),
      );
    }
  }) as (...args: never[]) => void);

  return {
    get connected() {
      return socket.connected;
    },
    onStatus: (listener) => {
      listeners.add(listener);

      return () => listeners.delete(listener);
    },
    call: (target, wire, signal) => {
      if (closed || !socket.connected) {
        return Promise.reject(hostUnavailable());
      }

      const id = nextId('c');
      const message: CallMessage = { kind: 'call', id, ...target, ...wire };

      return new Promise<unknown>((resolve, reject) => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const onAbort = () => {
          if (pending.has(id)) {
            socket.emit('cancel', { kind: 'cancel', id });
          }
        };
        const done = () => {
          clearTimeout(timer);
          signal?.removeEventListener('abort', onAbort);
        };

        pending.set(id, {
          resolve: (output) => {
            done();
            resolve(output);
          },
          reject: (error) => {
            done();
            reject(error);
          },
        });

        if (wire.deadline > 0) {
          timer = setTimeout(
            () => {
              if (pending.delete(id)) {
                socket.emit('cancel', { kind: 'cancel', id });
                done();
                reject(hostUnavailable());
              }
            },
            Math.max(0, wire.deadline - now()),
          );
        }

        signal?.addEventListener('abort', onAbort, { once: true });
        socket.emit('call', message);
      });
    },
    subscribe: (target, wire, sink) => {
      if (closed || !socket.connected) {
        queueMicrotask(() =>
          sink.end(
            new ContractError(
              'disconnected',
              'The host bridge is not connected.',
            ),
          ),
        );

        return () => undefined;
      }

      const id = nextId('s');
      const message: SubscribeMessage = {
        kind: 'subscribe',
        id,
        ...target,
        ...wire,
      };

      streams.set(id, sink);
      socket.emit('subscribe', message);

      return () => {
        if (streams.delete(id) && socket.connected) {
          socket.emit('unsubscribe', { kind: 'unsubscribe', id });
        }
      };
    },
    retry: () => {
      if (!closed && !socket.connected) {
        socket.disconnect();
        socket.connect();
      }
    },
    close: () => {
      closed = true;
      lost();
      socket.disconnect();
    },
  };
};
