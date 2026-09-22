import {
  parseTabs,
  restoreTabs,
  serializeTabs,
  tabsStorageKey,
} from '@/chat/tabs';
import { type Dispatch, type SetStateAction, useEffect, useState } from 'react';

import type { Thread } from './workspace';

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
 * against the backend on startup, and the write-back starts only after that
 * settles, so a failed lookup never overwrites what was stored.
 */
export const usePersistedTabs = ({
  isCurrent,
  onRestore,
  get,
}: TabsOptions): Tabs => {
  const [openThreads, setOpenThreads] = useState<readonly Thread[]>([]);
  const [selectedThreadId, setSelectedThreadId] = useState<string>();
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let active = true;
    const stored = parseTabs(localStorage.getItem(tabsStorageKey));
    if (stored === undefined) {
      setReady(true);
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
        setReady(true);
      })
      .catch(() => {
        // A transient lookup failure keeps the saved tabs for the next launch.
      });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (!ready) return;
    localStorage.setItem(
      tabsStorageKey,
      serializeTabs(openThreads, selectedThreadId),
    );
  }, [openThreads, selectedThreadId, ready]);

  return { openThreads, setOpenThreads, selectedThreadId, setSelectedThreadId };
};
