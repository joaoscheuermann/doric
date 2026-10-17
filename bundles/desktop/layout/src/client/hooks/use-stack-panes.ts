import { useSyncExternalStore } from 'react';

import type { StackPane } from '../../contracts/index.js';
import { isPaneOpen, stackStore } from '../stores/stack.js';

const NO_PANES: readonly StackPane[] = Object.freeze([]);

/**
 * The stack's panes top to bottom. The array keeps its identity until the stack
 * changes, which is what `useSyncExternalStore` needs to settle: a read building
 * a new array on every call re-renders without end.
 */
export const useStackPanes = (): readonly StackPane[] =>
  useSyncExternalStore(
    stackStore.subscribe,
    () => stackStore.getState().panes,
    () => NO_PANES,
  );

/** Whether the pane is expanded, re-read after every change of the stack. */
export const usePaneOpen = (paneId: string): boolean =>
  useSyncExternalStore(
    stackStore.subscribe,
    () => isPaneOpen(paneId),
    () => true,
  );
