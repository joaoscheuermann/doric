import {
  type SelectionLoad,
  selectionStorageKey,
  serializeSelection,
  shouldWriteSelection,
} from '@/domain/selection';
import type { Dispatch, SetStateAction } from 'react';
import { createStore } from 'zustand/vanilla';

/**
 * The selected Thread and its local persistence. A saved selection is
 * validated against the backend on startup; until that settles nothing is
 * written, and a failed lookup leaves what was stored alone while every change
 * that follows it is still saved. `shouldWriteSelection` decides that; this
 * store only reports when the read settled and when the selection was changed.
 */
export type PersistedSelectionState = {
  readonly selectedThreadId?: string;
  readonly load?: SelectionLoad;
  readonly changed: boolean;
  readonly changeSelectedThreadId: Dispatch<SetStateAction<string | undefined>>;
  readonly settleLoad: (load: SelectionLoad) => void;
};

const persist = (state: PersistedSelectionState): void => {
  if (!shouldWriteSelection(state.load, state.changed)) return;
  if (state.selectedThreadId === undefined) {
    localStorage.removeItem(selectionStorageKey);
    return;
  }
  localStorage.setItem(
    selectionStorageKey,
    serializeSelection(state.selectedThreadId),
  );
};

export const selectionStore = createStore<PersistedSelectionState>()((
  set,
  get,
) => {
  const commit = (next: Partial<PersistedSelectionState>): void => {
    set(next);
    persist(get());
  };
  return {
    changed: false,
    changeSelectedThreadId: (action) =>
      commit({
        selectedThreadId:
          typeof action === 'function'
            ? action(get().selectedThreadId)
            : action,
        changed: true,
      }),
    settleLoad: (load) => commit({ load }),
  };
});
