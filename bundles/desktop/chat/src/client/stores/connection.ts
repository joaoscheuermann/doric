import {
  type ConnectionStatus,
  type Disposable,
  DoricConnectionV1,
} from 'bundle/contracts';
import { createStore, type StoreApi } from 'zustand/vanilla';

import type { ConnectionSource } from '../api/thread-watch.js';
import { chatServices } from '../services/chat-services.js';

export type ConnectionState = {
  readonly status: ConnectionStatus;
};

export type ConnectionStore = StoreApi<ConnectionState>;

let mirror: { store: ConnectionStore; subscription: Disposable } | undefined;

/** A mirror of one connection source and its subscription. */
export const createConnectionStore = (
  connection: ConnectionSource,
): { store: ConnectionStore; subscription: Disposable } => {
  const store = createStore<ConnectionState>()(() => ({
    status: connection.status(),
  }));
  const subscription = connection.subscribe(() => {
    store.setState({ status: connection.status() });
  });
  return { store, subscription };
};

/**
 * The one mirror of the host's connection status, created on first use so the
 * status the window holds now is what a reader's first frame shows. The
 * platform owns the connection; this only follows its subscription.
 */
export const connectionStore = (): ConnectionStore => {
  if (mirror === undefined) {
    mirror = createConnectionStore(chatServices().use(DoricConnectionV1));
  }
  return mirror.store;
};

/** Ends the mirror when the chat part deactivates. */
export const resetConnectionStore = (): void => {
  mirror?.subscription.dispose();
  mirror = undefined;
};
