import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'desktop/ui/sonner';
import { useCallback, useRef, useState } from 'react';

import { api } from '../api/settings-api.js';
import type { Credential } from '../domain/config.js';
import { messageFrom } from '../domain/errors.js';
import { queryKeys } from '../queries/keys.js';

/** What the provider page's Claude sign-in row drives. */
export interface ClaudeLogin {
  /** Whether a sign-in is waiting for the browser. */
  readonly busy: boolean;
  /** The credential the last sign-in answered; `acknowledge` clears it. */
  readonly signedIn?: Credential;
  /** Starts a sign-in; the row's button disables itself while it waits. */
  readonly start: () => void;
  /** Cancels the waiting sign-in; its failure toast is silent. */
  readonly cancel: () => void;
  /** Clears `signedIn`, after the view applied the answer. */
  readonly acknowledge: () => void;
}

/**
 * The one Claude sign-in the settings window drives. `start` calls
 * `SettingsApi.claude.login` with the hook's own signal, and on the answer
 * settles the credential into the `credentials` query cache *before* it
 * publishes it as `signedIn` — so the render that runs the view's
 * auto-select effect already sees it in `credentials.list`, and the commit
 * the effect sends is one the configuration accepts. A failure toasts under
 * the id `claude-login`, except a failure of this hook's own signal, which
 * is the cancel it asked for and stays silent.
 */
export const useClaudeLogin = (): ClaudeLogin => {
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [signedIn, setSignedIn] = useState<Credential>();
  /** The sign-in in flight; its signal is what `cancel` aborts. */
  const inFlight = useRef<AbortController | undefined>(undefined);

  /** Settles an answered credential into the credentials cache: replace its row, or append it. */
  const settle = useCallback(
    (credential: Credential): void => {
      queryClient.setQueryData(
        queryKeys.credentials,
        (current: readonly Credential[] = []) =>
          current.some((entry) => entry.id === credential.id)
            ? current.map((entry) =>
                entry.id === credential.id ? credential : entry,
              )
            : [...current, credential],
      );
    },
    [queryClient],
  );

  const start = useCallback((): void => {
    const controller = new AbortController();
    inFlight.current = controller;
    setBusy(true);
    void (async () => {
      try {
        const signed = await api().claude.login({ signal: controller.signal });
        // Settle before the answer is published: the auto-select effect
        // commits against `credentials.list`, which is this cache.
        settle(signed);
        setSignedIn(signed);
        toast.success('Claude is signed in.', { id: 'claude-login' });
      } catch (error) {
        // A refusal of this hook's own cancel is the cancel it asked for.
        if (!controller.signal.aborted) {
          toast.error(messageFrom(error), { id: 'claude-login' });
        }
      } finally {
        setBusy(false);
      }
    })();
  }, [settle]);

  const cancel = useCallback((): void => {
    inFlight.current?.abort();
  }, []);

  const acknowledge = useCallback((): void => {
    setSignedIn(undefined);
  }, []);

  return { busy, signedIn, start, cancel, acknowledge };
};
