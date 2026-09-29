import {
  type Configuration,
  configurationInput,
  configurationIssue,
  type DoricConfiguration,
  isSameConfiguration,
  type ProviderKind,
} from '@/domain/config';
import { messageFrom } from '@/domain/workspace';
import { useCallback, useEffect, useRef, useState } from 'react';

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
 * The one place the settings surface reads and writes the host configuration.
 * The host owns it — it is a singleton with a revision — so a load seeds the
 * draft, and a save replaces both copies with what the host returned.
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
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  /** Interaction intent, so a load whose modal closed cannot land after it. */
  const intent = useRef(0);
  /** The settle timer that sends a change after typing stops. */
  const pending = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  /** The draft a save must read, whatever render scheduled it. */
  const latest = useRef<Configuration | undefined>(undefined);
  latest.current = draft;

  useEffect(() => {
    intent.current += 1;
    const request = intent.current;
    if (!open) {
      // Closing discards the draft: a pending change was flushed by the caller
      // before the modal closed, and a reopened modal reloads the host's copy.
      setSaved(undefined);
      setDraft(undefined);
      setError(undefined);
      setSaving(false);
      setLoading(false);
      return;
    }
    setError(undefined);
    setLoading(true);
    void window.doric.config
      .get()
      .then((loaded) => {
        if (intent.current !== request) return;
        setSaved(loaded);
        setDraft(loaded.configuration);
      })
      .catch((reason: unknown) => {
        if (intent.current === request) setError(messageFrom(reason));
      })
      .finally(() => {
        if (intent.current === request) setLoading(false);
      });
  }, [open]);

  const save = useCallback(async (): Promise<void> => {
    clearTimeout(pending.current);
    const next = latest.current;
    if (next === undefined) return;
    const request = intent.current;
    setSaving(true);
    setError(undefined);
    try {
      const updated = await window.doric.config.update(
        configurationInput(next),
      );
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
  }, []);

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
    loading,
    saved,
    saving,
    setDraft,
  };
};
