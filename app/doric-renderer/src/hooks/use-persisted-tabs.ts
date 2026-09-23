import {
  parseTabs,
  restoreTabs,
  serializeTabs,
  shouldWriteTabs,
  type TabsLoad,
  tabsStorageKey,
} from '@/domain/tabs';
import type { Thread } from '@/domain/workspace';
import {
  type Dispatch,
  type SetStateAction,
  useCallback,
  useEffect,
  useState,
} from 'react';

export type TabsOptions = {
  readonly isCurrent: () => boolean;
  readonly onRestore: (thread: Thread) => void;
  readonly get: (id: string) => Promise<Thread | undefined>;
};

export type Tabs = {
  readonly openThreads: readonly Thread[];
  readonly setOpenThreads: Dispatch<SetStateAction<readonly Thread[]>>;
  readonly selectedThreadId: string | undefined;
  readonly setSelectedThreadId: Dispatch<SetStateAction<string | undefined>>;
};

/**
 * Owns the open tab set and its local persistence. Saved tabs are validated
 * against the backend on startup; until that settles nothing is written, and a
 * failed lookup leaves what was stored alone while every tab change that follows
 * it is still saved. `shouldWriteTabs` decides that; this hook only reports when
 * the read settled and when the open tabs were changed.
 */
export const usePersistedTabs = ({
  isCurrent,
  onRestore,
  get,
}: TabsOptions): Tabs => {
  const [openThreads, setOpenThreads] = useState<readonly Thread[]>([]);
  const [selectedThreadId, setSelectedThreadId] = useState<string>();
  const [load, setLoad] = useState<TabsLoad>();
  const [changed, setChanged] = useState(false);

  useEffect(() => {
    let active = true;
    const stored = parseTabs(localStorage.getItem(tabsStorageKey));
    if (stored === undefined) {
      setLoad('none');
      return () => {
        active = false;
      };
    }
    void restoreTabs(stored, get)
      .then(({ openThreads: restored, selectedThread }) => {
        if (!active) return;
        // A user who acted while restoration was pending owns the newer state.
        if (isCurrent()) {
          setOpenThreads(restored);
          if (selectedThread) onRestore(selectedThread);
        }
        setLoad('restored');
      })
      .catch(() => {
        if (!active) return;
        // The saved tabs stay: the write that would erase them is held back,
        // and the read failure never disables the writes that follow it.
        setLoad('failed');
      });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (!shouldWriteTabs(load, changed)) return;
    localStorage.setItem(
      tabsStorageKey,
      serializeTabs(openThreads, selectedThreadId),
    );
  }, [changed, load, openThreads, selectedThreadId]);

  const changeOpenThreads = useCallback<
    Dispatch<SetStateAction<readonly Thread[]>>
  >((action) => {
    setChanged(true);
    setOpenThreads(action);
  }, []);

  const changeSelectedThreadId = useCallback<
    Dispatch<SetStateAction<string | undefined>>
  >((action) => {
    setChanged(true);
    setSelectedThreadId(action);
  }, []);

  return {
    openThreads,
    setOpenThreads: changeOpenThreads,
    selectedThreadId,
    setSelectedThreadId: changeSelectedThreadId,
  };
};
