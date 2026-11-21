import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';

import type { ProviderFieldItemProps } from '../../contracts/index.js';
import {
  applyProviderDraft,
  type Credential,
  emptyProviderDraft,
  kindOf,
  type ProviderDraft,
  type ProviderKind,
  providerDraftOf,
} from '../domain/config.js';
import { queryKeys } from '../queries/keys.js';
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
  /**
   * Takes an item's answer: reads the credentials again, then writes `value`
   * into `configuration[item.field]` if the open provider is still of `item.kind`.
   */
  answerField(item: ProviderFieldItemProps, value: string): void;
}

/** An item's answer, waiting for the render that sees the credentials it read. */
interface Answered {
  readonly kind: string;
  readonly field: string;
  readonly value: string;
}

/**
 * One provider page over the configuration's draft. The position is how a
 * row addresses its provider, and the same one the page edits, so the order a
 * list draws rows in never decides which is opened. An item's answer writes
 * its value into the open page of its kind.
 */
export const useProviderPage = ({
  config,
  kinds,
  credentials,
}: {
  readonly config: Config;
  readonly kinds: readonly ProviderKind[];
  readonly credentials: readonly Credential[];
}): ProviderPage => {
  const queryClient = useQueryClient();
  const [provider, setProvider] = useState<ProviderDraft>();
  const [answered, setAnswered] = useState<Answered>();
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

  const answerField = (item: ProviderFieldItemProps, value: string): void => {
    void (async () => {
      await queryClient.refetchQueries({ queryKey: queryKeys.credentials });
      setAnswered({ kind: item.kind, field: item.field, value });
    })();
  };

  // An answer is written once the render after the credentials' read runs:
  // this render's `change` already sees what the item stored in `credentials`,
  // so the commit is one the host accepts. A `.then` on the read would close
  // over the stale list it started with, which is why the answer travels as
  // state through an effect instead, reading this render's page and `change`.
  // Only a page of the item's kind takes the value: the answer may land after
  // the window moved to another provider.
  const latest = useRef({ provider, change });
  latest.current = { provider, change };
  useEffect(() => {
    if (answered === undefined) return;
    setAnswered(undefined);
    const { provider: open, change: write } = latest.current;
    if (open?.kind !== answered.kind) return;
    write({
      ...open,
      configuration: {
        ...open.configuration,
        [answered.field]: answered.value,
      },
    });
  }, [answered]);

  return { provider, open, openNew, close, change, answerField };
};
