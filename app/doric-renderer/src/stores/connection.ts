import type { ConnectionStatus } from '@/domain/connection';
import { createStore, type StoreApi } from 'zustand/vanilla';

export type ConnectionState = {
  readonly status: ConnectionStatus;
};

export type ConnectionStore = StoreApi<ConnectionState>;

let mirror: ConnectionStore | undefined;

/**
 * The one mirror of the host's connection status, created on first use so the
 * status the host holds now is what a reader's first frame shows. The host owns
 * the connection; this only follows its subscription.
 */
export const connectionStore = (): ConnectionStore => {
  if (mirror === undefined) {
    const created = createStore<ConnectionState>()(() => ({
      status: window.doric.connection.status(),
    }));
    window.doric.connection.subscribe(() => {
      created.setState({ status: window.doric.connection.status() });
    });
    mirror = created;
  }
  return mirror;
};
