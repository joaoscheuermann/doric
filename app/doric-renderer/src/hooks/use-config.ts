import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';

import {
  type Configuration,
  type ConfigurationInput,
  configurationInput,
  configurationIssue,
  type DoricConfiguration,
  enableExecutionReasoning,
  isSameConfiguration,
  type ProviderKind,
} from '@/domain/config';
import { messageFrom } from '@/domain/workspace';
import { queryKeys } from '@/queries/keys';

/** How long typing settles before a valid change sends itself to the host. */
const saveDelayMs = 500;

export type Config = {
  readonly dirty: boolean;
  readonly draft?: Configuration;
  readonly error?: string;
  /** Sends a valid, dirty draft now; a field blur or a close calls this. */
  readonly flush: () => Promise<void>;
  /** The first reason the host would refuse the draft, if any. */
  readonly issue?: string;
  readonly loading: boolean;
  /**
   * What the last save the host accepted answered, and how many have landed. A
   * surface announcing saves reads the revision, because two saves that stored
   * the same value carry different ones.
   */
  readonly saved?: DoricConfiguration;
  readonly saving: boolean;
  readonly setDraft: (next: Configuration) => void;
};

/**
 * The one place a surface reads and writes the host configuration. The host owns
 * it — it is a singleton with a revision — so a load seeds the draft, and a save
 * replaces both copies with what the host returned. The configuration is shared
 * by the workspace window and the settings window, so the hook also rereads it
 * when its window regains focus, keeping one window's draft from writing back
 * over a change the other one saved.
 *
 * There is no Save button, so the hook saves by itself: a valid change sends
 * itself once typing settles, and `flush` sends it at once for a field blur or
 * a close. A draft the host would refuse is never sent; a failed save surfaces
 * the host's message and keeps the user's draft. What a save sends is the
 * draft as `configurationInput` reads it, which is where a write-only token
 * becomes the body the host stores.
 *
 * The kind catalog travels in because a provider's fields and lists are the
 * kind's, so the hook cannot say whether the draft is valid without it.
 */
export const useConfig = (
  open: boolean,
  kinds: readonly ProviderKind[],
): Config => {
  const [saved, setSaved] = useState<DoricConfiguration>();
  const [draft, setDraft] = useState<Configuration>();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  /** Interaction intent, so a load whose modal closed cannot land after it. */
  const intent = useRef(0);
  /** The settle timer that sends a change after typing stops. */
  const pending = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  /** The draft a save must read, whatever render scheduled it. */
  const latest = useRef<Configuration | undefined>(undefined);
  latest.current = draft;
  const queryClient = useQueryClient();
  const load = useQuery({
    queryKey: queryKeys.config,
    queryFn: () => window.doric.config.get(),
    enabled: open,
  });
  const { mutateAsync: write } = useMutation({
    mutationFn: (configuration: ConfigurationInput) =>
      window.doric.config.update(configuration),
  });

  // A load starts when the modal opens and again when the window regains focus.
  // Closing discards the draft: a pending change was flushed by the caller
  // before the modal closed, and a reopened modal reloads the host's copy.
  useEffect(() => {
    intent.current += 1;
    if (!open) {
      setSaved(undefined);
      setDraft(undefined);
      setError(undefined);
      setSaving(false);
      return;
    }
    setError(undefined);
    void queryClient.refetchQueries({ queryKey: queryKeys.config });
  }, [open, queryClient]);

  // The configuration is shared by the workspace window and the settings window,
  // so a save in one leaves the other holding a stale draft — which its next save
  // would write back over the other window's change. Rereading on focus is what
  // keeps a window's draft from overwriting a change made in the other one.
  useEffect(() => {
    const onFocus = () => {
      intent.current += 1;
      if (!open) return;
      setError(undefined);
      void queryClient.refetchQueries({ queryKey: queryKeys.config });
    };
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [open, queryClient]);

  // Every answered load seeds both copies with what the host stores, which is
  // what keeps a window from writing its draft back over the other window's
  // change once the read lands.
  useEffect(() => {
    if (!open || load.data === undefined) return;
    setSaved(load.data);
    setDraft(enableExecutionReasoning(load.data.configuration));
  }, [load.data, open]);

  const save = useCallback(async (): Promise<void> => {
    clearTimeout(pending.current);
    const next = latest.current;
    if (next === undefined) return;
    const request = intent.current;
    setSaving(true);
    setError(undefined);
    try {
      const updated = await write(configurationInput(next));
      if (intent.current !== request) return;
      setSaved(updated);
      // Keep a draft the user changed while the request was in flight.
      if (
        latest.current !== undefined &&
        isSameConfiguration(latest.current, next)
      ) {
        setDraft(updated.configuration);
      }
    } catch (reason) {
      if (intent.current === request) setError(messageFrom(reason));
    } finally {
      if (intent.current === request) setSaving(false);
    }
  }, [write]);

  const flush = useCallback(async (): Promise<void> => {
    clearTimeout(pending.current);
    const next = latest.current;
    if (
      next === undefined ||
      saved === undefined ||
      isSameConfiguration(saved.configuration, next) ||
      configurationIssue(next, kinds) !== undefined
    ) {
      return;
    }
    await save();
  }, [kinds, saved, save]);

  // A valid change sends itself once typing settles; a draft the host would
  // refuse is left to the section that explains it.
  useEffect(() => {
    if (draft === undefined || saved === undefined) return;
    if (isSameConfiguration(saved.configuration, draft)) return;
    if (configurationIssue(draft, kinds) !== undefined) return;
    const timer = setTimeout(() => void save(), saveDelayMs);
    pending.current = timer;
    return () => clearTimeout(timer);
  }, [draft, kinds, saved, save]);

  const issue =
    draft === undefined ? undefined : configurationIssue(draft, kinds);
  const dirty =
    draft !== undefined &&
    saved !== undefined &&
    !isSameConfiguration(saved.configuration, draft);

  return {
    dirty,
    draft,
    error,
    flush,
    issue,
    loading: open && (load.isPending || load.isFetching),
    saved,
    saving,
    setDraft,
  };
};
