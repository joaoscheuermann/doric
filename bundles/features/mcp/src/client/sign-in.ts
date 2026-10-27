// The browser sign-ins of the pane's http servers, held by the activation
// (D9-17) so a pane that collapses and opens again neither loses one nor
// reports one twice. The host prepares the authorization (`signIn`), the
// system browser opens it, and the host waits for its answer
// (`finishSignIn`, up to ten minutes). Only the preparation keeps the row's
// control disabled: once the browser opened, signing in again restarts the
// sign-in, which the host answers by cancelling the waiting one.
//
// Each server's toasts share one id, so the latest attempt owns them: an
// attempt a newer one replaced ends silently, whatever the host answers it.

import { toast } from 'desktop/ui/sonner';

import type { McpServerView } from '../contracts/index.js';
import { failureMessage, type McpApi } from './api.js';
import type { McpServersStore } from './store.js';

export interface McpSignIns {
  /** Signs in to `server`, replacing a sign-in of it still waiting. */
  start(server: McpServerView): void;
  /** Ends every sign-in's toasts and state; the host cancels its own. */
  dispose(): void;
}

export const createMcpSignIns = ({
  store,
  api,
}: {
  readonly store: McpServersStore;
  readonly api: McpApi;
}): McpSignIns => {
  /** The latest attempt of each server; an older one is superseded. */
  const latest = new Map<string, symbol>();
  let active = true;

  const start = (server: McpServerView): void => {
    const attempt = Symbol(server.id);
    const id = `mcp-sign-in-${server.id}`;
    const current = (): boolean => active && latest.get(server.id) === attempt;
    latest.set(server.id, attempt);
    store.setSigningIn(server.id, true);
    // A link a replaced attempt left on screen authorizes nothing any more.
    toast.dismiss(id);

    const signIn = async (): Promise<void> => {
      try {
        const url = await api.signIn(server.projectId, server.id);
        if (!current()) return;
        try {
          await api.openBrowser(url);
        } catch {
          // The host may run where no browser does: the link stays on screen
          // until the sign-in ends, with a way to copy it.
          if (current()) offerLink(id, url, server.name);
        }
        if (!current()) return;
        store.setSigningIn(server.id, false);
        await api.finishSignIn(server.projectId, server.id);
        if (current()) toast.dismiss(id);
      } catch (error) {
        if (current()) toast.error(failureMessage(error), { id });
      } finally {
        if (current()) {
          latest.delete(server.id);
          store.setSigningIn(server.id, false);
        }
      }
    };

    void signIn();
  };

  return {
    start,
    dispose: () => {
      active = false;
      for (const serverId of latest.keys()) {
        toast.dismiss(`mcp-sign-in-${serverId}`);
        store.setSigningIn(serverId, false);
      }
      latest.clear();
    },
  };
};

/** The authorization link a browser that did not open leaves to the reader. */
const offerLink = (id: string, url: string, name: string): void => {
  toast.info(`Open this link in a browser to sign in to ${name}.`, {
    id,
    description: url,
    duration: Number.POSITIVE_INFINITY,
    action: {
      label: 'Copy link',
      onClick: (event) => {
        // The link stays: copying it is not signing in.
        event.preventDefault();
        void navigator.clipboard
          .writeText(url)
          .catch((error: unknown) =>
            toast.error(failureMessage(error), { id: `${id}-copy` }),
          );
      },
    },
  });
};
