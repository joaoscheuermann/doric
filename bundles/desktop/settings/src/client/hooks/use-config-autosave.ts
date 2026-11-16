import { HooksV1, type Services, WindowHooksV1 } from 'bundle/contracts';
import { toastError } from 'desktop/ui/error-notice';
import { toast } from 'desktop/ui/sonner';
import { useEffect, useRef } from 'react';

import { settingsErrorCatalog } from '../domain/error-catalog.js';
import type { Config } from './use-config.js';

/**
 * What a surface that autosaves the configuration owes the user: the save
 * still waiting on the debounce settles as the window closes, and each save
 * the host refused is toasted under `config-save-failed`, and each save it
 * accepted under `config-save`, after dismissing that failure (§4). The first load is recorded, not announced: it is not a save.
 */
export const useConfigAutosave = (services: Services, config: Config): void => {
  const { flush } = config;
  // The revision already accounted for, so a render never repeats a message. The
  // load sets the same `saved` a write does, and the load is not a save, so the
  // first revision the hook hands over is recorded before anything is announced.
  const announced = useRef<number | undefined>(undefined);
  const loaded = useRef(false);
  if (!loaded.current && config.saved !== undefined) {
    loaded.current = true;
    announced.current = config.saved.revision;
  }

  // Closing the window is what settles a change still waiting on the debounce,
  // so the window's close waits for this answer (the platform's flush phase,
  // bounded by its deadline); a `beforeunload` listener would race the teardown
  // instead. The handler is bound while the page is mounted, because the hook's
  // `flush` reads the live draft.
  useEffect(() => {
    const registration = services
      .use(HooksV1)
      .use(WindowHooksV1)
      .onFlushHook(() => flush());
    return () => registration.dispose();
  }, [services, flush]);

  // A save the host refused is announced where the change was made, not only in
  // the footer: the reason names a field the user is looking at. One id holds
  // every refusal, so a refusal replaces the last one instead of stacking on
  // every attempt the debounce makes.
  useEffect(() => {
    if (config.error !== undefined) {
      toastError({
        id: 'config-save-failed',
        error: config.error,
        catalog: settingsErrorCatalog,
        fallbackCode: 'config_save_failed',
      });
    }
  }, [config.error]);

  // A save the host accepted is confirmed the same way. This surface has no Save
  // button — a change sends itself once typing settles — so the confirmation is
  // the only thing that says the host took it, and it is keyed on the revision so
  // one accepted save is announced exactly once, however many renders follow.
  useEffect(() => {
    const revision = config.saved?.revision;
    if (revision === undefined || announced.current === revision) return;
    announced.current = revision;
    toast.dismiss('config-save-failed');
    toast.success('Settings saved.', { id: 'config-save' });
  }, [config.saved]);
};
