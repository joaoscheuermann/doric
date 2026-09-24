import {
  parseSelection,
  type SelectionLoad,
  selectionStorageKey,
  serializeSelection,
  shouldWriteSelection,
} from '@/domain/selection';
import type { Thread } from '@/domain/workspace';
import {
  type Dispatch,
  type SetStateAction,
  useCallback,
  useEffect,
  useState,
} from 'react';

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
 * that follows it is still saved. `shouldWriteSelection` decides that; this hook
 * only reports when the read settled and when the selection was changed.
 */
export const usePersistedSelection = ({
  isCurrent,
  onRestore,
  get,
}: SelectionOptions): PersistedSelection => {
  const [selectedThreadId, setSelectedThreadId] = useState<string>();
  const [load, setLoad] = useState<SelectionLoad>();
  const [changed, setChanged] = useState(false);

  useEffect(() => {
    let active = true;
    const stored = parseSelection(localStorage.getItem(selectionStorageKey));
    if (stored === undefined) {
      setLoad('none');
      return () => {
        active = false;
      };
    }
    void get(stored.selectedThreadId)
      .then((thread) => {
        if (!active) return;
        // A user who acted while restoration was pending owns the newer state.
        if (thread !== undefined && isCurrent()) onRestore(thread);
        setLoad('restored');
      })
      .catch(() => {
        if (!active) return;
        // The saved selection stays: the write that would erase it is held back,
        // and the read failure never disables the writes that follow it.
        setLoad('failed');
      });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (!shouldWriteSelection(load, changed)) return;
    if (selectedThreadId === undefined) {
      localStorage.removeItem(selectionStorageKey);
      return;
    }
    localStorage.setItem(
      selectionStorageKey,
      serializeSelection(selectedThreadId),
    );
  }, [changed, load, selectedThreadId]);

  const changeSelectedThreadId = useCallback<
    Dispatch<SetStateAction<string | undefined>>
  >((action) => {
    setChanged(true);
    setSelectedThreadId(action);
  }, []);

  return { setSelectedThreadId: changeSelectedThreadId };
};
