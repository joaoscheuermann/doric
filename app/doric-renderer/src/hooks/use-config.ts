import {
  type Configuration,
  configurationIssue,
  type DoricConfiguration,
  isSameConfiguration,
} from '@/domain/config';
import { messageFrom } from '@/domain/workspace';
import { useEffect, useRef, useState } from 'react';

export type Config = {
  /** Whether the draft differs from the host's copy and the host would accept it. */
  readonly canSave: boolean;
  readonly dirty: boolean;
  readonly draft?: Configuration;
  readonly error?: string;
  /** The first reason the host would refuse the draft, if any. */
  readonly issue?: string;
  readonly loading: boolean;
  readonly reset: () => void;
  readonly save: () => Promise<boolean>;
  readonly saved?: DoricConfiguration;
  readonly saving: boolean;
  readonly setDraft: (next: Configuration) => void;
};

/**
 * The one place the settings surface reads and writes the host configuration.
 * The host owns it — it is a singleton with a revision — so a load seeds the
 * draft, and a save replaces both copies with what the host returned. A failed
 * save surfaces its message and keeps the user's draft; closing never saves.
 */
export const useConfig = (open: boolean): Config => {
  const [saved, setSaved] = useState<DoricConfiguration>();
  const [draft, setDraft] = useState<Configuration>();
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  /** Interaction intent, so a load whose modal closed cannot land after it. */
  const intent = useRef(0);

  useEffect(() => {
    intent.current += 1;
    const request = intent.current;
    if (!open) {
      // Closing discards everything, including a draft the user never saved.
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

  const reset = (): void => {
    setDraft(saved?.configuration);
    setError(undefined);
    setSaving(false);
  };

  const save = async (): Promise<boolean> => {
    const next = draft;
    if (next === undefined) return false;
    const request = intent.current;
    setSaving(true);
    setError(undefined);
    try {
      const updated = await window.doric.config.update(next);
      if (intent.current !== request) return false;
      setSaved(updated);
      setDraft(updated.configuration);
      return true;
    } catch (reason) {
      if (intent.current === request) setError(messageFrom(reason));
      return false;
    } finally {
      setSaving(false);
    }
  };

  const issue = draft === undefined ? undefined : configurationIssue(draft);
  const dirty =
    draft !== undefined &&
    saved !== undefined &&
    !isSameConfiguration(saved.configuration, draft);

  return {
    canSave: dirty && issue === undefined && !saving,
    dirty,
    draft,
    error,
    issue,
    loading,
    reset,
    save,
    saved,
    saving,
    setDraft,
  };
};
