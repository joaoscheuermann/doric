// The terminal client a chat element of this bundle reads, over fakes of the
// host boundary only: the window's real terminal store (`src/client/store.ts`)
// fed by a fake `watchProject` stream, a fake output `watch` per terminal, and
// a fake `stop` call. A test drives the streams and reads what the element
// asked of them: the Projects followed and unfollowed, the output watches
// opened and closed, the stops called and the toasts shown.

import type { TerminalApi } from '../../../src/client/api.js';
import type {
  Terminal,
  TerminalOutputUpdate,
  TerminalUpdate,
} from '../../../src/client/domain/terminals.js';
import type { TerminalClient } from '../../../src/client/elements.js';

/** The fake host behind one terminal client, and what it was asked. */
export interface TerminalHost {
  readonly client: TerminalClient;
  /** The Projects whose terminal list was watched (`store.follow`), in order. */
  readonly followed: readonly string[];
  /** The Projects whose list watch was closed. */
  readonly listsClosed: readonly string[];
  /** The Projects `store.unfollow` was called for. */
  readonly unfollowed: readonly string[];
  /** The terminals whose output was watched (`watches.watch`), in order. */
  readonly watched: readonly string[];
  /** The terminals whose output watch was closed, in order. */
  readonly watchesClosed: readonly string[];
  /** The terminals `api.stop` was called for, in order. */
  readonly stopped: readonly string[];
  /** The failures the store showed as toasts, in order. */
  readonly toasts: readonly string[];
  /** Sends the Project's terminal list, as its stream's snapshot does. */
  list(projectId: string, terminals: readonly Terminal[]): void;
  /** Sends one terminal's update, as its Project's stream does. */
  update(terminal: Terminal): void;
  /** Sends output to the open watch of `terminalId`. */
  output(terminalId: string, update: TerminalOutputUpdate): void;
}

const unused = (): never => {
  throw new Error('The test does not expect this terminal call.');
};

/**
 * A terminal client over a fake host.
 * - `stopFails`: `api.stop` rejects with this message, as a refused stop does.
 */
export const terminalHost = async (
  options: { readonly stopFails?: string } = {},
): Promise<TerminalHost> => {
  const { createTerminalStore } = await import('../../../src/client/store.js');
  const followed: string[] = [];
  const listsClosed: string[] = [];
  const unfollowed: string[] = [];
  const watched: string[] = [];
  const watchesClosed: string[] = [];
  const stopped: string[] = [];
  const toasts: string[] = [];
  const listListeners = new Map<string, (update: TerminalUpdate) => void>();
  const outputListeners = new Map<
    string,
    (update: TerminalOutputUpdate) => void
  >();

  const api: TerminalApi = {
    list: unused,
    create: unused,
    snapshot: unused,
    input: unused,
    resize: unused,
    rename: unused,
    stop: async (id) => {
      stopped.push(id);
      if (options.stopFails !== undefined) throw new Error(options.stopFails);
    },
  };

  const watchProject = (
    projectId: string,
    listener: (update: TerminalUpdate) => void,
  ): (() => void) => {
    followed.push(projectId);
    listListeners.set(projectId, listener);
    return () => {
      listsClosed.push(projectId);
      if (listListeners.get(projectId) === listener)
        listListeners.delete(projectId);
    };
  };

  const store = createTerminalStore({
    api,
    watchProject,
    toastError: (message) => toasts.push(message),
    openTerminal: async () => undefined,
    closeTab: () => undefined,
    retitleTab: () => undefined,
    refreshFiles: () => undefined,
  });

  const client: TerminalClient = {
    api,
    watches: {
      watchProject,
      watch: (id, _afterSequence, listener) => {
        watched.push(id);
        outputListeners.set(id, listener);
        let open = true;
        return () => {
          if (!open) return;
          open = false;
          watchesClosed.push(id);
          if (outputListeners.get(id) === listener) outputListeners.delete(id);
        };
      },
    },
    store: {
      ...store,
      unfollow: (projectId) => {
        unfollowed.push(projectId);
        store.unfollow(projectId);
      },
    },
    open: () => undefined,
  };

  return {
    client,
    followed,
    listsClosed,
    unfollowed,
    watched,
    watchesClosed,
    stopped,
    toasts,
    list: (projectId, terminals) =>
      listListeners.get(projectId)?.({ kind: 'snapshot', terminals }),
    update: (terminal) =>
      listListeners.get(terminal.projectId)?.({ kind: 'updated', terminal }),
    output: (terminalId, update) => outputListeners.get(terminalId)?.(update),
  };
};
