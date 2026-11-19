import { errorInfo } from 'desktop/reads';
import { toastError } from 'desktop/ui/error-notice';
import { toast } from 'desktop/ui/sonner';
import { useCallback, useEffect, useRef, useState } from 'react';

import type { CredentialDescription } from '../contracts/index.js';
import type { ClaudeLoginApi } from './api.js';
import { claudeLoginErrorCatalog } from './error-catalog.js';

/** What the sign-in row drives. */
export interface ClaudeLogin {
  /** Whether a sign-in is waiting for the browser. */
  readonly busy: boolean;
  /**
   * The authorization page the waiting sign-in opened, so the row can offer
   * it again when no browser came up.
   */
  readonly url?: string;
  /** Starts a sign-in; the row's button disables itself while it waits. */
  readonly start: () => void;
  /** Cancels the waiting sign-in; its failure toast is silent. */
  readonly cancel: () => void;
}

/**
 * One Claude sign-in. `start` asks the host to prepare the sign-in, opens the
 * answered URL in the system browser — the host may run where no browser
 * does — and waits on `finish` with the hook's own signal. A finished sign-in
 * runs `onSignedIn` with the answered credential, then toasts under
 * `claude-login` after dismissing a failure; a failure toasts under
 * `claude-login-failed`, except a failure of this hook's own signal, which is
 * the cancel it asked for and stays silent. `onSignedIn` runs with the
 * answered credential before the success toast. A sign-in that finishes after
 * the hook's component is gone runs no `onSignedIn` and toasts no success: it
 * toasts the info `claude-login-finished` instead, so the stored login is not
 * lost silently.
 */
export const useClaudeLogin = (
  api: ClaudeLoginApi,
  onSignedIn: (credential: CredentialDescription) => void,
): ClaudeLogin => {
  const [busy, setBusy] = useState(false);
  const [url, setUrl] = useState<string>();
  /** The sign-in in flight; its signal is what `cancel` aborts. */
  const inFlight = useRef<AbortController | undefined>(undefined);
  const latest = useRef({ api, onSignedIn });
  latest.current = { api, onSignedIn };
  /** Whether the component is still mounted, so a finish has someone to answer. */
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const start = useCallback((): void => {
    const controller = new AbortController();
    inFlight.current = controller;
    setBusy(true);
    void (async () => {
      const { api } = latest.current;
      try {
        const signal = controller.signal;
        const authorizeUrl = await api.start({ signal });
        setUrl(authorizeUrl);
        try {
          await api.openBrowser(authorizeUrl);
        } catch {
          // The row shows the URL while the sign-in waits, so a browser
          // that did not open is one click away rather than a failure.
        }
        const signed = await api.finish({ signal });
        toast.dismiss('claude-login-failed');
        if (!mounted.current) {
          toast.info(
            'Claude sign-in finished; open the provider page again to use it.',
            { id: 'claude-login-finished' },
          );
          return;
        }
        latest.current.onSignedIn(signed);
        toast.success('Claude is signed in.', { id: 'claude-login' });
      } catch (error) {
        // A refusal of this hook's own cancel is the cancel it asked for.
        if (!controller.signal.aborted) {
          toastError({
            id: 'claude-login-failed',
            error: errorInfo(error),
            catalog: claudeLoginErrorCatalog,
            fallbackCode: 'sign_in_failed',
          });
        }
      } finally {
        if (inFlight.current === controller) inFlight.current = undefined;
        setUrl(undefined);
        setBusy(false);
      }
    })();
  }, []);

  const cancel = useCallback((): void => {
    inFlight.current?.abort();
  }, []);

  return { busy, url, start, cancel };
};
