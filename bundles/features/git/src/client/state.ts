// The git client's window-wide state, bound to the activation (never to an
// element's services, D9-17): the query client and its reads, and the files
// refresh coordinator while the files bundle serves it.

import type { FilesRefresh } from './api/peers.js';
import type { GitStore } from './changes/store.js';

export interface GitClient {
  readonly store: GitStore;
  /** `files.refresh/v1`, while some bundle provides it. */
  readonly refresh: () => FilesRefresh | undefined;
}

let current: GitClient | undefined;

export const setGitClient = (client: GitClient | undefined): void => {
  current = client;
};

/** The activation's state; elements only render while it is set. */
export const gitClient = (): GitClient | undefined => current;

/**
 * Refreshes a Project's reads: through the files coordinator, which rereads
 * every registrant of the window (the files tree too), or this client alone
 * without one.
 */
export const requestProjectRefresh = (projectId: string): void => {
  const client = current;
  if (client === undefined) return;
  const refresh = client.refresh();
  if (refresh !== undefined) {
    refresh.request(projectId);
    return;
  }
  void client.store.refresh(projectId, false).catch(() => undefined);
};

/**
 * Refreshes a Project's reads and resolves once this client's reads settled,
 * as the branch switch awaited the window's refresh before it finished.
 */
export const settleProjectRefresh = async (
  projectId: string,
): Promise<void> => {
  const client = current;
  if (client === undefined) return;
  client.refresh()?.request(projectId);
  await client.store.refresh(projectId, false);
};
