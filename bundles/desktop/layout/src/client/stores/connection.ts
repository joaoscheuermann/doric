import type { Disposable } from 'bundle/contracts';
import { createStore, type StoreApi } from 'zustand/vanilla';

import type { ConnectionSource } from '../api/project-watch.js';
import type { ConnectionStatus } from '../domain/connection.js';

export type ConnectionState = {
  readonly status: ConnectionStatus;
};

export type ConnectionStore = StoreApi<ConnectionState>;

let mirror: ConnectionStore | undefined;
let subscription: Disposable | undefined;

/**
 * Starts the one mirror of the host's connection status, from
 * `doric.connection/v1` (D9-5): the status the window holds now is what a
 * reader's first frame shows. The platform owns the connection; this only
 * follows its subscription.
 */
export const initConnection = (source: ConnectionSource): void => {
  disposeConnection();
  const created = createStore<ConnectionState>()(() => ({
    status: source.status(),
  }));
  subscription = source.subscribe((status) => {
    created.setState({ status });
  });
  mirror = created;
};

export const disposeConnection = (): void => {
  subscription?.dispose();
  subscription = undefined;
  mirror = undefined;
};

const offline: ConnectionStore = createStore<ConnectionState>()(() => ({
  status: 'disconnected',
}));

/** The mirror; `disconnected` until the bundle is active. */
export const connectionStore = (): ConnectionStore => mirror ?? offline;
