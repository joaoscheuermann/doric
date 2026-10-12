// The files client's window-wide state, bound to the activation (never to an
// element's services, D9-17): the sandbox store and the refresh coordinator.

import type { RefreshCoordinator } from './refresh/coordinator.js';
import type { SandboxStore } from './sandbox-store.js';

export interface FilesClient {
  readonly store: SandboxStore;
  readonly coordinator: RefreshCoordinator;
}

let current: FilesClient | undefined;

export const setFilesClient = (client: FilesClient | undefined): void => {
  current = client;
};

/** The activation's state; elements only render while it is set. */
export const filesClient = (): FilesClient | undefined => current;
