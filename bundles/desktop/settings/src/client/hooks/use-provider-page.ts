import { useCallback, useEffect, useState } from 'react';

import {
  applyProviderDraft,
  type Credential,
  emptyProviderDraft,
  kindOf,
  type ProviderDraft,
  type ProviderKind,
  providerDraftOf,
} from '../domain/config.js';
import type { ClaudeLogin } from './use-claude-login.js';
import type { Config } from './use-config.js';

/** The provider page a surface has open, and what opens, edits and closes it. */
export interface ProviderPage {
  /**
   * The draft being configured, or `undefined` while no page is open. It
   * carries the provider's list position, so a list and the page cannot
   * disagree about which provider is open.
   */
  readonly provider: ProviderDraft | undefined;
  /** Opens the page of the provider at one list position; a position with none opens nothing. */
  open(index: number): void;
  /** Opens the page for a provider that does not exist yet, of the first kind. */
  openNew(): void;
  /** Closes the page; the same function on every render. */
  close(): void;
  /**
   * Takes the page's next draft and writes it into the configuration as soon
   * as it is one the host would accept; a draft not yet valid stays local.
   */
  change(next: ProviderDraft): void;
}

/**
 * One provider page over the configuration's draft. The position is how a
 * row addresses its provider, and the same one the page edits, so the order a
 * list draws rows in never decides which is opened. A finished Claude sign-in
 * names its credential on an open `claude` page.
 */
export const useProviderPage = ({
  config,
  kinds,
  credentials,
  claudeLogin,
}: {
  readonly config: Config;
  readonly kinds: readonly ProviderKind[];
  readonly credentials: readonly Credential[];
  readonly claudeLogin: ClaudeLogin;
}): ProviderPage => {
  const [provider, setProvider] = useState<ProviderDraft>();
  const { draft } = config;

  const open = (index: number): void => {
    if (draft === undefined) return;
    const next = providerDraftOf(draft, index);
    if (next !== undefined) setProvider(next);
  };

  const openNew = (): void => {
    const first = kinds[0];
    if (first !== undefined) setProvider(emptyProviderDraft(first));
  };

  const close = useCallback((): void => setProvider(undefined), []);

  /**
   * Writes the provider page's draft into the configuration as soon as it is one
   * the host would accept, so the window's own save carries it and leaving the
   * page needs no commit of its own. A draft that is not yet valid stays local:
   * a half-typed id or a missing field never reaches the list, nor does it stop
   * the rest of the window from saving.
   */
  const change = (next: ProviderDraft): void => {
    const kind = kindOf(kinds, next.kind);
    if (draft === undefined || kind === undefined) {
      setProvider(next);
      return;
    }
    const applied = applyProviderDraft(draft, next, kind, credentials);
    if (applied === undefined) {
      setProvider(next);
      return;
    }
    setProvider(applied.draft);
    config.setDraft(applied.configuration);
  };

  // A finished sign-in names its credential on the open `claude` provider
  // page: the hook settled it into the credentials cache before it published
  // it, so this render's `change` already sees it in `credentials` and the
  // commit is one the host accepts. A `.then` on the login promise would close
  // over the stale list the promise started with, which is why the answer
  // travels as state through an effect instead.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the auto-select commits once, when a sign-in answers, never on the renders that recreate `change` and `provider`; the answer it commits is the live draft.
  useEffect(() => {
    const signed = claudeLogin.signedIn;
    if (signed === undefined) return;
    claudeLogin.acknowledge();
    // Only a `claude` page takes the token: the sign-in may answer after the
    // window moved to another provider, which would then send a Claude token.
    if (provider?.kind === 'claude') {
      change({
        ...provider,
        configuration: { ...provider.configuration, token: signed.id },
      });
    }
  }, [claudeLogin.signedIn]);

  return { provider, open, openNew, close, change };
};
