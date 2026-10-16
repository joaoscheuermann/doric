// The files activation's window-wide state as the stories seed it: a sandbox
// store whose tree read answers one fixed observation, and a refresh
// coordinator that records nothing. Elements read it through `filesClient()`,
// so a story installs it before its component mounts.

import type { Disposable } from 'bundle/contracts';

import type { RefreshCoordinator } from '../../src/client/refresh/coordinator.js';
import {
  createQueryClient,
  type SandboxStore,
} from '../../src/client/sandbox-store.js';
import { setFilesClient } from '../../src/client/state.js';
import {
  emptyExpansion,
  expansionScope,
  expansionStore,
} from '../../src/client/stores/expansion.js';
import type { TreeObservation } from '../../src/contracts/index.js';

const disposed: Disposable = { dispose: () => undefined };

const coordinator: RefreshCoordinator = {
  register: () => disposed,
  request: () => undefined,
  setWorkspace: () => undefined,
  dispose: () => undefined,
};

/** A store whose every tree read shows `tree`. */
export const fixedSandboxStore = (tree: TreeObservation): SandboxStore => ({
  client: createQueryClient(),
  observeTree: (_scope, listener) => {
    listener(tree);
    return disposed;
  },
  refresh: async () => undefined,
  dispose: () => undefined,
});

/** Installs the files client the elements read, with this tree read. */
export const seedFilesClient = (tree: TreeObservation): void => {
  setFilesClient({ store: fixedSandboxStore(tree), coordinator });
};

/** Opens these directories of one Project and root in the expansion store. */
export const seedExpansion = (
  projectId: string,
  root: string,
  open: ReadonlySet<string> = emptyExpansion,
): void => {
  expansionStore.setState({
    views: { [expansionScope(projectId, root)]: open },
  });
};
