// The host end of the desktop bridge (HR-1): the Socket.IO namespace
// `/doric/bridge` on the host's HTTP server. Each message is emitted under its
// `kind` and carries the whole envelope message: the desktop sends `call`,
// `cancel`, `subscribe` and `unsubscribe`; the host answers `result`, `event`
// and `end`. Calls resolve in the kernel's active view, as principal `doric`,
// and reach only the methods of the host allowlist (HR-10, `allowlist.ts`).

import type { KernelPlatform } from 'bundle';
import {
  type CallOptions,
  ContractError,
  type Disposable,
  ref,
  toContractError,
} from 'bundle/contracts';
import {
  type CallMessage,
  isTupleSchema,
  memberSchema,
  type SubscribeMessage,
  streamItemSchema,
  type WireCall,
  type WireError,
  wireMessageSchema,
} from 'bundle/runtime';
import type { Server, Socket } from 'socket.io';

import { assertBridgeAllowed } from './allowlist.js';

export const BRIDGE_NAMESPACE = '/doric/bridge';

export interface BridgeLog {
  warn(fields: object, message: string): void;
}

const wireErrorOf = (error: unknown): WireError => {
  const contractError = toContractError(error);

  return {
    code: contractError.code,
    message: contractError.message,
    ...(contractError.details === undefined
      ? {}
      : { details: contractError.details }),
  };
};

type Target = Pick<CallMessage, 'contract' | 'method' | 'input'> & WireCall;

/** The stub arguments of one bridge request: the input spread when it is a tuple. */
const argumentsOf = (
  platform: KernelPlatform,
  target: Target,
  stream: boolean,
): unknown[] => {
  const spec = platform.methodSpec(target.contract, target.method);

  if (spec === undefined) {
    // The stub answers `unavailable` (or waits for a respawning generation).
    return [target.input];
  }

  const isStream =
    streamItemSchema(memberSchema(spec.input, 'input').schema) !== undefined;

  if (isStream !== stream) {
    throw new ContractError(
      'invalid_input',
      stream
        ? `${target.contract} ${target.method} is not a stream.`
        : `${target.contract} ${target.method} is a stream; subscribe to it.`,
      { contract: target.contract, method: target.method },
    );
  }

  if (!isTupleSchema(spec.input)) {
    return [target.input];
  }

  if (!Array.isArray(target.input)) {
    throw new ContractError(
      'invalid_input',
      `Invalid input for ${target.contract} ${target.method}: expected the argument tuple.`,
      { contract: target.contract, method: target.method },
    );
  }

  return [...target.input];
};

/** The `doric` stub method a request targets (every name dispatches). */
const methodOf = (
  platform: KernelPlatform,
  target: Target,
): ((...args: unknown[]) => unknown) => {
  const api = platform.services.use(
    ref(target.contract as `${string}/v${number}`),
    target.scope,
  ) as unknown as Record<string, (...args: unknown[]) => unknown>;

  return api[target.method] as (...args: unknown[]) => unknown;
};

const callOptions = (signal: AbortSignal, deadline: number): CallOptions => ({
  signal,
  ...(deadline > 0 ? { deadline } : {}),
});

/** Serves one desktop connection until it disconnects. */
const serve = (platform: KernelPlatform, socket: Socket, log: BridgeLog) => {
  const calls = new Map<string, AbortController>();
  const streams = new Map<string, { dispose(): void }>();

  const call = async (message: CallMessage) => {
    const controller = new AbortController();

    calls.set(message.id, controller);

    try {
      assertBridgeAllowed(message.contract, message.method);
      const args = argumentsOf(platform, message, false);
      const output = await methodOf(platform, message)(
        ...args,
        callOptions(controller.signal, message.deadline),
      );

      if (calls.has(message.id)) {
        socket.emit('result', {
          kind: 'result',
          id: message.id,
          ok: true,
          output,
        });
      }
    } catch (error) {
      if (calls.has(message.id)) {
        socket.emit('result', {
          kind: 'result',
          id: message.id,
          ok: false,
          error: wireErrorOf(error),
        });
      }
    } finally {
      calls.delete(message.id);
    }
  };

  const subscribe = async (message: SubscribeMessage) => {
    const { id } = message;
    const controller = new AbortController();
    const open = { dispose: () => controller.abort() };
    const end = (error?: unknown) => {
      if (streams.get(id) === open) {
        streams.delete(id);
        open.dispose();
        socket.emit('end', {
          kind: 'end',
          id,
          ...(error === undefined ? {} : { error: wireErrorOf(error) }),
        });
      }
    };

    streams.set(id, open);

    try {
      assertBridgeAllowed(message.contract, message.method);
      const args = argumentsOf(platform, message, true);
      const held = (await methodOf(platform, message)(
        ...args,
        {
          next: (item: unknown) => {
            if (streams.get(id) === open) {
              socket.emit('event', { kind: 'event', id, values: [item] });
            }
          },
          end: (error?: unknown) => end(error),
        },
        callOptions(controller.signal, message.deadline),
      )) as Disposable | undefined;

      if (streams.get(id) === open) {
        open.dispose = () => {
          controller.abort();
          held?.dispose();
        };
      } else {
        held?.dispose();
      }
    } catch (error) {
      end(error);
    }
  };

  const received = (kind: string) => (raw: unknown) => {
    const parsed = wireMessageSchema.safeParse(raw);

    if (!parsed.success || parsed.data.kind !== kind) {
      const id = (raw as { id?: unknown } | null)?.id;

      log.warn({ kind }, 'Refused a malformed host bridge message');

      if (typeof id === 'string' && (kind === 'call' || kind === 'subscribe')) {
        const error: WireError = {
          code: 'invalid_input',
          message: `Malformed ${kind} message.`,
        };

        socket.emit(
          kind === 'call' ? 'result' : 'end',
          kind === 'call'
            ? { kind: 'result', id, ok: false, error }
            : { kind: 'end', id, error },
        );
      }

      return;
    }

    const message = parsed.data;

    switch (message.kind) {
      case 'call':
        void call(message);
        break;
      case 'cancel':
        calls.get(message.id)?.abort();
        break;
      case 'subscribe':
        void subscribe(message);
        break;
      case 'unsubscribe': {
        const open = streams.get(message.id);

        streams.delete(message.id);
        open?.dispose();
        break;
      }
      default:
        break;
    }
  };

  for (const kind of ['call', 'cancel', 'subscribe', 'unsubscribe']) {
    socket.on(kind, received(kind));
  }

  socket.on('disconnect', () => {
    for (const controller of calls.values()) {
      controller.abort();
    }

    calls.clear();

    for (const open of [...streams.values()]) {
      open.dispose();
    }

    streams.clear();
  });
};

/** Opens `/doric/bridge` on the host's Socket.IO server (HR-1). */
export const installBridge = (options: {
  readonly io: Server;
  readonly platform: KernelPlatform;
  readonly log: BridgeLog;
}): void => {
  options.io
    .of(BRIDGE_NAMESPACE)
    .on('connection', (socket) => serve(options.platform, socket, options.log));
};
