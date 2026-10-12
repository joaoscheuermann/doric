// Envelope transports over Electron's utility process channel: main's end
// (`UtilityProcess`) and the runner's end (`process.parentPort`). Messages
// are structured-cloned by Electron.

import { ContractError } from 'bundle/contracts';
import type { LinkCloseReason, Transport, WireMessage } from 'bundle/runtime';

const closedError = (): ContractError =>
  new ContractError('unavailable', 'The process channel is closed.');

interface ChildLike {
  postMessage(message: unknown): void;
  on(event: 'message', listener: (message: unknown) => void): void;
  off(event: 'message', listener: (message: unknown) => void): void;
  once(event: 'exit', listener: (code: number) => void): void;
  kill(): boolean;
}

const closer = () => {
  const listeners = new Set<(reason: LinkCloseReason) => void>();
  let reason: LinkCloseReason | undefined;

  return {
    get reason() {
      return reason;
    },
    close: (next: LinkCloseReason) => {
      if (reason !== undefined) {
        return;
      }

      reason = next;

      for (const listener of [...listeners]) {
        listener(next);
      }

      listeners.clear();
    },
    onClose: (listener: (reason: LinkCloseReason) => void) => {
      if (reason !== undefined) {
        listener(reason);

        return () => undefined;
      }

      listeners.add(listener);

      return () => listeners.delete(listener);
    },
  };
};

/** Main's end: closes when the utility process exits. */
export const utilityTransport = (child: ChildLike): Transport => {
  const state = closer();

  child.once('exit', (code) =>
    state.close({ kind: 'exited', code, signal: null }),
  );

  return {
    send: (message: WireMessage) => {
      if (state.reason !== undefined) {
        throw closedError();
      }

      child.postMessage(message);
    },
    onMessage: (listener) => {
      child.on('message', listener);

      return () => child.off('message', listener);
    },
    onClose: state.onClose,
    close: () => {
      child.kill();
    },
  };
};

interface ParentPortLike {
  postMessage(message: unknown): void;
  on(event: 'message', listener: (event: { data: unknown }) => void): void;
  off(event: 'message', listener: (event: { data: unknown }) => void): void;
}

/** The runner's end: `process.parentPort` of a utility process. */
export const parentPortTransport = (port: ParentPortLike): Transport => {
  const state = closer();

  return {
    send: (message: WireMessage) => {
      if (state.reason !== undefined) {
        throw closedError();
      }

      port.postMessage(message);
    },
    onMessage: (listener) => {
      const handler = (event: { data: unknown }) => listener(event.data);

      port.on('message', handler);

      return () => port.off('message', handler);
    },
    onClose: state.onClose,
    close: () => state.close({ kind: 'stopped' }),
  };
};
