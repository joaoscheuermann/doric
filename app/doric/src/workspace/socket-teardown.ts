import type { Socket } from 'socket.io-client';

/**
 * One renderer window, as a stream holds it: told once when the window is
 * destroyed, and able to say whether it already is.
 */
export type DestroyedTarget = {
  once(event: 'destroyed', listener: () => void): void;
  off(event: 'destroyed', listener: () => void): void;
  isDestroyed(): boolean;
};

/** Silences a socket before closing it, so no late frame reaches a torn-down watch. */
export const teardownSocket = (
  socket: Pick<Socket, 'removeAllListeners' | 'disconnect'>,
): void => {
  socket.removeAllListeners();
  socket.disconnect();
};
