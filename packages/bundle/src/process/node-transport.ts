import type { ChildProcess } from 'node:child_process';

import { ContractError } from '../contracts/error.js';
import type { LinkCloseReason, Transport } from '../runtime/envelope/link.js';
import type { WireMessage } from '../runtime/envelope/messages.js';

const closedError = (): ContractError =>
  new ContractError('unavailable', 'The process channel is closed.');

interface Channel {
  readonly send: (message: WireMessage) => void;
  readonly on: (listener: (message: unknown) => void) => () => void;
  readonly close: () => void;
}

const transportOf = (
  channel: Channel,
  watchClose: (close: (reason: LinkCloseReason) => void) => void,
): Transport => {
  const listeners = new Set<(reason: LinkCloseReason) => void>();
  let reason: LinkCloseReason | undefined;
  const close = (next: LinkCloseReason) => {
    if (reason !== undefined) {
      return;
    }

    reason = next;

    for (const listener of [...listeners]) {
      listener(next);
    }

    listeners.clear();
  };

  watchClose(close);

  return {
    send: (message) => {
      if (reason !== undefined) {
        throw closedError();
      }

      channel.send(message);
    },
    onMessage: (listener) => channel.on(listener),
    onClose: (listener) => {
      if (reason !== undefined) {
        listener(reason);

        return () => undefined;
      }

      listeners.add(listener);

      return () => listeners.delete(listener);
    },
    close: () => channel.close(),
  };
};

/**
 * The kernel's end of a generation process forked with `serialization:
 * 'advanced'`: it closes when the process exits.
 */
export const childTransport = (child: ChildProcess): Transport =>
  transportOf(
    {
      send: (message) => {
        if (!child.connected) {
          throw closedError();
        }

        // A send that fails later (the process died) surfaces as its exit.
        child.send(message, (error) => {
          void error;
        });
      },
      on: (listener) => {
        child.on('message', listener);

        return () => child.off('message', listener);
      },
      close: () => {
        if (child.connected) {
          child.disconnect();
        }
      },
    },
    (close) => {
      // Without a listener an IPC error would be thrown in the kernel.
      child.on('error', () => undefined);
      child.once('exit', (code, signal) =>
        close({ kind: 'exited', code, signal }),
      );

      if (child.exitCode !== null || child.signalCode !== null) {
        close({
          kind: 'exited',
          code: child.exitCode,
          signal: child.signalCode,
        });
      }
    },
  );

/** The generation process's end of the IPC channel to its kernel. */
export const parentTransport = (): Transport => {
  const send = process.send?.bind(process);

  if (send === undefined) {
    throw new Error(
      'The generation runner needs an IPC channel to its kernel.',
    );
  }

  return transportOf(
    {
      send: (message) => {
        if (!process.connected) {
          throw closedError();
        }

        send(message, undefined, undefined, (error: Error | null) => {
          void error;
        });
      },
      on: (listener) => {
        process.on('message', listener);

        return () => process.off('message', listener);
      },
      close: () => {
        if (process.connected) {
          process.disconnect();
        }
      },
    },
    (close) => {
      process.once('disconnect', () => close({ kind: 'disconnected' }));
    },
  );
};
