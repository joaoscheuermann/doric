import { ContractError } from '../../contracts/error.js';
import type { LinkCloseReason, Transport } from './link.js';
import type { WireMessage } from './messages.js';

export interface TransportPair {
  readonly left: Transport;
  readonly right: Transport;
  /** Ends both sides as a process exit would (the default: SIGKILL). */
  sever(reason?: LinkCloseReason): void;
}

/**
 * Two connected in-memory transports. Each message is structured-cloned when
 * it is sent (so a value that could not cross a process fails at the sender)
 * and delivered on a microtask, in order.
 */
export const createTransportPair = (): TransportPair => {
  let closed = false;
  const listeners = [
    new Set<(message: unknown) => void>(),
    new Set<(message: unknown) => void>(),
  ] as const;
  const closeListeners = [
    new Set<(reason: LinkCloseReason) => void>(),
    new Set<(reason: LinkCloseReason) => void>(),
  ] as const;
  const end = (reasons: readonly [LinkCloseReason, LinkCloseReason]) => {
    if (closed) {
      return;
    }

    closed = true;
    queueMicrotask(() => {
      for (const side of [0, 1] as const) {
        for (const listener of [...closeListeners[side]]) {
          listener(reasons[side]);
        }
      }
    });
  };
  const side = (index: 0 | 1): Transport => {
    const peer = index === 0 ? 1 : 0;

    return {
      send: (message: WireMessage) => {
        if (closed) {
          throw new ContractError('unavailable', 'The link is closed.');
        }

        const copy = structuredClone(message);

        // Messages sent before a close are still delivered, as over IPC.
        queueMicrotask(() => {
          for (const listener of [...listeners[peer]]) {
            listener(copy);
          }
        });
      },
      onMessage: (listener) => {
        listeners[index].add(listener);

        return () => listeners[index].delete(listener);
      },
      onClose: (listener) => {
        closeListeners[index].add(listener);

        return () => closeListeners[index].delete(listener);
      },
      close: () =>
        end(
          index === 0
            ? [{ kind: 'stopped' }, { kind: 'disconnected' }]
            : [{ kind: 'disconnected' }, { kind: 'stopped' }],
        ),
    };
  };

  return {
    left: side(0),
    right: side(1),
    sever: (reason = { kind: 'exited', code: null, signal: 'SIGKILL' }) =>
      end([reason, { kind: 'disconnected' }]),
  };
};
