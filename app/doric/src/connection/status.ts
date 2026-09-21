import { Manager } from 'socket.io-client';

import { workspaceUrl } from '../workspace/config';

export type ConnectionStatus = 'connected' | 'disconnected';
export type ConnectionListener = (status: ConnectionStatus) => void;

type ConnectionEvent = 'connect' | 'disconnect' | 'connect_error';

export type ConnectionSocket = {
  readonly connected: boolean;
  on(event: ConnectionEvent, listener: () => void): void;
  off(event: ConnectionEvent, listener: () => void): void;
};

export type ConnectionMonitor = {
  status(): ConnectionStatus;
  subscribe(listener: ConnectionListener): () => void;
  close(): void;
};

export const createConnectionMonitor = (
  socket: ConnectionSocket,
  closeSocket: () => void,
): ConnectionMonitor => {
  let current: ConnectionStatus = socket.connected
    ? 'connected'
    : 'disconnected';
  let closed = false;
  const listeners = new Set<ConnectionListener>();

  const publish = (status: ConnectionStatus): void => {
    if (closed || current === status) return;
    current = status;
    listeners.forEach((listener) => listener(status));
  };
  const connected = (): void => publish('connected');
  const disconnected = (): void => publish('disconnected');

  socket.on('connect', connected);
  socket.on('disconnect', disconnected);
  socket.on('connect_error', disconnected);

  return {
    status: () => current,
    subscribe: (listener) => {
      if (closed) return () => undefined;
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    close: () => {
      if (closed) return;
      publish('disconnected');
      closed = true;
      socket.off('connect', connected);
      socket.off('disconnect', disconnected);
      socket.off('connect_error', disconnected);
      listeners.clear();
      closeSocket();
    },
  };
};

/** Creates the process-long connection to the local Doric host. */
export const createConnectionService = (): ConnectionMonitor => {
  const manager = new Manager(workspaceUrl, {
    transports: ['websocket'],
    reconnection: true,
  });
  const socket = manager.socket('/status');
  return createConnectionMonitor(socket, () => socket.disconnect());
};
