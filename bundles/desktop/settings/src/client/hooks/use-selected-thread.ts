import { useCallback, useRef, useSyncExternalStore } from 'react';
import type { Thread } from 'runtime/contracts';

import { api } from '../api/settings-api.js';

/**
 * The workspace's selected Thread, re-rendered on every
 * `api().workspace.subscribe` notification; `undefined` without a selection
 * or without `layout.workspace/v1`.
 */
export const useSelectedThread = (): Thread | undefined => {
  // A record read through the service is a fresh copy on every call, so the
  // snapshot is a version counter bumped on every notification.
  const version = useRef(0);
  const subscribe = useCallback((onChange: () => void) => {
    const subscription = api().workspace.subscribe(() => {
      version.current += 1;
      onChange();
    });
    return () => subscription.dispose();
  }, []);
  useSyncExternalStore(subscribe, () => version.current);

  return api().workspace.selectedThread();
};
