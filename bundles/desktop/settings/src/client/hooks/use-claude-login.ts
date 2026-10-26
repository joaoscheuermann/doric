import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'desktop/ui/sonner';
import { useCallback, useRef, useState, useSyncExternalStore } from 'react';

import { api } from '../api/settings-api.js';
import type { Credential } from '../domain/config.js';
import { messageFrom } from '../domain/errors.js';
import { queryKeys } from '../queries/keys.js';

/**
 * Whether a `claude.login/v1` provider answers: the contract is optional, so a
 * composition without the `claude-login` bundle keeps a working settings
 * window that simply draws no sign-in row. The client part's activation sets
 * it through `whenAvailable`.
 */
let claudeLoginAvailable = false;
const availabilityListeners = new Set<() => void>();

/** Records whether a `claude.login/v1` provider is active, telling every reader. */
export const setClaudeLoginAvailable = (available: boolean): void => {
  if (claudeLoginAvailable === available) return;
  claudeLoginAvailable = available;
  for (const listener of [...availabilityListeners]) listener();
};

/** Whether the sign-in can be offered, as React state. */
export const useClaudeLoginAvailable = (): boolean =>
  useSyncExternalStore(
    (listener) => {
      availabilityListeners.add(listener);
      return () => availabilityListeners.delete(listener);
    },
    () => claudeLoginAvailable,
  );

/** What the provider page's Claude sign-in row drives. */
export interface ClaudeLogin {
  /** Whether a sign-in is waiting for the browser. */
  readonly busy: boolean;
  /**
   * The authorization page the waiting sign-in opened, so the row can offer
   * it again when no browser came up.
   */
  readonly url?: string;
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
 * The one Claude sign-in the settings window drives. `start` asks the host
 * to prepare the sign-in (`SettingsApi.claude.start`), opens the answered
 * URL in the system browser — the host may run where no browser does — and
 * waits on `SettingsApi.claude.finish` with the hook's own signal. On the
 * answer it settles the credential into the `credentials` query cache
 * *before* it publishes it as `signedIn` — so the render that runs the
 * view's auto-select effect already sees it in `credentials.list`, and the
 * commit the effect sends is one the configuration accepts. A failure
 * toasts under the id `claude-login`, except a failure of this hook's own
 * signal, which is the cancel it asked for and stays silent.
 */
export const useClaudeLogin = (): ClaudeLogin => {
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [url, setUrl] = useState<string>();
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
        const signal = controller.signal;
        const authorizeUrl = await api().claude.start({ signal });
        setUrl(authorizeUrl);
        try {
          await api().openBrowser(authorizeUrl);
        } catch {
          // The row shows the URL while the sign-in waits, so a browser
          // that did not open is one click away rather than a failure.
        }
        const signed = await api().claude.finish({ signal });
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
        if (inFlight.current === controller) inFlight.current = undefined;
        setUrl(undefined);
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

  return { busy, url, signedIn, start, cancel, acknowledge };
};
