// The MCP pane's state, held by the activation (D9-17): the Project the
// selection shows, the servers its `mcp/v1.watch` delivered last (none until
// the first delivery), the failure that ended the watch, if any, and the
// servers whose sign-in is being prepared. Elements read it through
// `useSyncExternalStore`, so every read returns a value whose identity holds
// until it changes; an element that unmounts (a collapsed pane) loses none of
// it.

import type { Disposable } from 'bundle/contracts';

import type { McpServerView } from '../contracts/index.js';

const NONE: readonly McpServerView[] = Object.freeze([]);

const NO_IDS: ReadonlySet<string> = new Set();

export interface McpServersStore {
  /** The selected Project's id; undefined while no Project is selected. */
  projectId(): string | undefined;
  /** The servers the Project's watch delivered last, in creation order. */
  servers(): readonly McpServerView[];
  /** Whether the selected Project's watch delivered (or failed) at least once. */
  loaded(): boolean;
  /** Why the watch stopped, while it stays stopped. */
  failure(): string | undefined;
  /** The servers whose sign-in is asking the host and opening the browser. */
  signingIn(): ReadonlySet<string>;
  /** Shows another Project: its servers are unknown until its watch answers. */
  select(projectId: string | undefined): void;
  setServers(servers: readonly McpServerView[]): void;
  setFailure(message: string | undefined): void;
  setSigningIn(serverId: string, signingIn: boolean): void;
  subscribe(listener: () => void): Disposable;
}

export const createMcpServersStore = (): McpServersStore => {
  let projectId: string | undefined;
  let servers = NONE;
  let loaded = false;
  let failure: string | undefined;
  let signingIn = NO_IDS;
  const listeners = new Set<() => void>();

  const notify = (): void => {
    for (const listener of [...listeners]) listener();
  };

  return {
    projectId: () => projectId,
    servers: () => servers,
    loaded: () => loaded,
    failure: () => failure,
    signingIn: () => signingIn,
    select: (next) => {
      if (next === projectId) return;
      projectId = next;
      servers = NONE;
      loaded = false;
      failure = undefined;
      notify();
    },
    setServers: (next) => {
      servers = Object.freeze([...next]);
      loaded = true;
      failure = undefined;
      notify();
    },
    setFailure: (message) => {
      if (message === failure) return;
      failure = message;
      if (message !== undefined) loaded = true;
      notify();
    },
    setSigningIn: (serverId, next) => {
      if (signingIn.has(serverId) === next) return;
      const ids = new Set(signingIn);
      if (next) ids.add(serverId);
      else ids.delete(serverId);
      signingIn = ids;
      notify();
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return { dispose: () => listeners.delete(listener) };
    },
  };
};
