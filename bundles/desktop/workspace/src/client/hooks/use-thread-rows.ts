import { useSyncExternalStore } from 'react';

import type { ThreadRows } from '../../contracts/index.js';
import { threadRowsStore } from '../stores/thread-rows.js';

/**
 * The rows other bundles add under each Thread (`layout.sidebar/v1`). The
 * component re-renders whenever a registration or one of its counts changes.
 */
export const useThreadRows = (): readonly ThreadRows[] => {
  useSyncExternalStore(
    threadRowsStore.subscribe,
    () => threadRowsStore.getState().revision,
  );
  return threadRowsStore.getState().rows;
};
