import type {
  ConnectionListener,
  ConnectionMonitor,
  ConnectionStatus,
} from './status';

export const connectionStatusChannel = 'doric:connection:status';

export type ConnectionState = {
  status(): ConnectionStatus;
  subscribe(listener: ConnectionListener): () => void;
};

export const createConnectionState = (): ConnectionState & {
  update(status: ConnectionStatus): void;
} => {
  let current: ConnectionStatus = 'disconnected';
  const listeners = new Set<ConnectionListener>();

  return {
    status: () => current,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    update: (status) => {
      if (current === status) return;
      current = status;
      listeners.forEach((listener) => listener(status));
    },
  };
};

export type ConnectionTarget = {
  on(event: 'did-finish-load', listener: () => void): void;
  once(event: 'destroyed', listener: () => void): void;
  off(event: 'did-finish-load' | 'destroyed', listener: () => void): void;
  isDestroyed(): boolean;
  send(channel: string, status: ConnectionStatus): void;
};

/** Binds status delivery to one renderer lifecycle. */
export const bindConnectionStatus = (
  target: ConnectionTarget,
  connection: ConnectionMonitor,
): (() => void) => {
  let loaded = false;
  let active = true;

  const send = (status: ConnectionStatus): void => {
    if (loaded && active && !target.isDestroyed()) {
      target.send(connectionStatusChannel, status);
    }
  };
  const loadedListener = (): void => {
    loaded = true;
    send(connection.status());
  };
  const unsubscribe = connection.subscribe(send);
  const cleanup = (): void => {
    if (!active) return;
    active = false;
    unsubscribe();
    target.off('did-finish-load', loadedListener);
    target.off('destroyed', cleanup);
  };

  target.on('did-finish-load', loadedListener);
  target.once('destroyed', cleanup);
  return cleanup;
};
