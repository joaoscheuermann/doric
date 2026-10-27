// The MCP pane's state, held by the activation (D9-17): the Project the
// selection shows, the servers its `mcp/v1.watch` delivered last, and the
// failure that ended the watch, if any. Elements read it through
// `useSyncExternalStore`, so every read returns a value whose identity holds
// until it changes.

import type { Disposable } from 'bundle/contracts';

import type { McpServerView } from '../contracts/index.js';

const NONE: readonly McpServerView[] = Object.freeze([]);

export interface McpServersStore {
  /** The selected Project's id; undefined while no Project is selected. */
  projectId(): string | undefined;
  /** The servers the Project's watch delivered last, in creation order. */
  servers(): readonly McpServerView[];
  /** Why the watch stopped, while it stays stopped. */
  failure(): string | undefined;
  /** Shows another Project: its servers are unknown until its watch answers. */
  select(projectId: string | undefined): void;
  setServers(servers: readonly McpServerView[]): void;
  setFailure(message: string | undefined): void;
  subscribe(listener: () => void): Disposable;
}

export const createMcpServersStore = (): McpServersStore => {
  let projectId: string | undefined;
  let servers = NONE;
  let failure: string | undefined;
  const listeners = new Set<() => void>();

  const notify = (): void => {
    for (const listener of [...listeners]) listener();
  };

  return {
    projectId: () => projectId,
    servers: () => servers,
    failure: () => failure,
    select: (next) => {
      if (next === projectId) return;
      projectId = next;
      servers = NONE;
      failure = undefined;
      notify();
    },
    setServers: (next) => {
      servers = Object.freeze([...next]);
      failure = undefined;
      notify();
    },
    setFailure: (message) => {
      if (message === failure) return;
      failure = message;
      notify();
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return { dispose: () => listeners.delete(listener) };
    },
  };
};
