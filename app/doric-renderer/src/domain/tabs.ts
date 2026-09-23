import type { Thread } from './workspace';

export const tabsStorageKey = 'doric.tabs';

export type TabsState = {
  readonly version: 1;
  readonly openThreadIds: readonly string[];
  readonly selectedThreadId?: string;
};

export type RestoredTabs = {
  readonly openThreads: readonly Thread[];
  readonly selectedThread?: Thread;
};

export const serializeTabs = (
  openThreads: readonly Thread[],
  selectedThreadId?: string,
): string =>
  JSON.stringify({
    version: 1,
    openThreadIds: openThreads.map(({ id }) => id),
    ...(selectedThreadId === undefined ? {} : { selectedThreadId }),
  } satisfies TabsState);

export const parseTabs = (value: string | null): TabsState | undefined => {
  if (value === null) return undefined;
  try {
    const parsed: unknown = JSON.parse(value);
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      !('version' in parsed) ||
      parsed.version !== 1 ||
      !('openThreadIds' in parsed) ||
      !Array.isArray(parsed.openThreadIds) ||
      !parsed.openThreadIds.every((id) => typeof id === 'string') ||
      ('selectedThreadId' in parsed &&
        parsed.selectedThreadId !== undefined &&
        typeof parsed.selectedThreadId !== 'string')
    ) {
      return undefined;
    }
    return parsed as unknown as TabsState;
  } catch {
    return undefined;
  }
};

/**
 * Resolves saved tab IDs in their stored order. A missing Thread is stale state
 * and is discarded; a thrown lookup failure aborts restoration so a transient
 * backend problem never overwrites the saved tabs.
 */
export const restoreTabs = async (
  state: TabsState | undefined,
  get: (id: string) => Promise<Thread | undefined>,
): Promise<RestoredTabs> => {
  if (state === undefined) return { openThreads: [] };
  const uniqueIds = [...new Set(state.openThreadIds)];
  const resolved = await Promise.all(uniqueIds.map((id) => get(id)));
  const openThreads = resolved.filter(
    (thread): thread is Thread => thread !== undefined,
  );
  const selectedThread =
    openThreads.find(({ id }) => id === state.selectedThreadId) ??
    openThreads[0];
  return { openThreads, selectedThread };
};

/**
 * What the initial read of the saved tabs found.
 *
 * `none`     — nothing was stored.
 * `restored` — the stored tabs were resolved against the backend.
 * `failed`   — the read failed, so what is stored may still be intact.
 */
export type TabsLoad = 'none' | 'restored' | 'failed';

/**
 * Whether the tabs on screen may be written to storage.
 *
 * Nothing is written while the read is in flight. Once it settles a write
 * proceeds, except after a read that failed: the tabs the hook holds are then
 * the untouched ones, and writing them would erase what is still stored, so that
 * first write waits for a change. Persistence itself does not stop — the change
 * that arrives, and every change after it, is written — so a transient failure
 * only delays the write-back instead of ending it for the session.
 */
export const shouldWriteTabs = (
  load: TabsLoad | undefined,
  changed: boolean,
): boolean => load !== undefined && (load !== 'failed' || changed);
