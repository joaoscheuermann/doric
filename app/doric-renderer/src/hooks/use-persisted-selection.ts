import { useQueryClient } from '@tanstack/react-query';
import { type Dispatch, type SetStateAction, useEffect, useRef } from 'react';

import { parseSelection, selectionStorageKey } from '@/domain/selection';
import type { Thread } from '@/domain/workspace';
import { queryKeys } from '@/queries/keys';
import { selectionStore } from '@/stores/selection';

export type SelectionOptions = {
  readonly isCurrent: () => boolean;
  readonly onRestore: (thread: Thread) => void;
  readonly get: (id: string) => Promise<Thread | undefined>;
};

export type PersistedSelection = {
  readonly setSelectedThreadId: Dispatch<SetStateAction<string | undefined>>;
};

/**
 * Owns the selected Thread and its local persistence. A saved selection is
 * validated against the backend on startup; until that settles nothing is
 * written, and a failed lookup leaves what was stored alone while every change
 * that follows it is still saved. `shouldWriteSelection` decides that; the
 * selection store only reports when the read settled and when the selection was
 * changed.
 */
export const usePersistedSelection = ({
  isCurrent,
  onRestore,
  get,
}: SelectionOptions): PersistedSelection => {
  const queryClient = useQueryClient();
  /**
   * Read when the fetch settles rather than captured at mount: the restore runs
   * once, but a later render's callbacks are the ones that carry the current
   * selection intent, so they are the ones the settled lookup must consult.
   */
  const options = useRef({ get, isCurrent, onRestore });
  options.current = { get, isCurrent, onRestore };

  useEffect(() => {
    let active = true;
    const stored = parseSelection(localStorage.getItem(selectionStorageKey));
    if (stored === undefined) {
      selectionStore.getState().settleLoad('none');
      return () => {
        active = false;
      };
    }
    void queryClient
      .fetchQuery({
        queryKey: queryKeys.thread(stored.selectedThreadId),
        queryFn: () => options.current.get(stored.selectedThreadId),
      })
      .then((thread) => {
        if (!active) return;
        // A user who acted while restoration was pending owns the newer state.
        if (thread !== undefined && options.current.isCurrent())
          options.current.onRestore(thread);
        selectionStore.getState().settleLoad('restored');
      })
      .catch(() => {
        if (!active) return;
        // The saved selection stays: the write that would erase it is held back,
        // and the read failure never disables the writes that follow it.
        selectionStore.getState().settleLoad('failed');
      });
    return () => {
      active = false;
    };
  }, [queryClient.fetchQuery]);

  return {
    setSelectedThreadId: selectionStore.getState().changeSelectedThreadId,
  };
};
