export const selectionStorageKey = 'doric.selection';

export type SelectionState = {
  readonly version: 1;
  readonly selectedThreadId: string;
};

export const serializeSelection = (selectedThreadId: string): string =>
  JSON.stringify({
    version: 1,
    selectedThreadId,
  } satisfies SelectionState);

export const parseSelection = (
  value: string | null,
): SelectionState | undefined => {
  if (value === null) return undefined;
  try {
    const parsed: unknown = JSON.parse(value);
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      !('version' in parsed) ||
      parsed.version !== 1 ||
      !('selectedThreadId' in parsed) ||
      typeof parsed.selectedThreadId !== 'string'
    ) {
      return undefined;
    }
    return parsed as unknown as SelectionState;
  } catch {
    return undefined;
  }
};

/**
 * What the initial read of the saved selection found.
 *
 * `none`     — nothing was stored.
 * `restored` — the stored Thread was resolved against the backend.
 * `failed`   — the read failed, so what is stored may still be intact.
 */
export type SelectionLoad = 'none' | 'restored' | 'failed';

/**
 * Whether the selected Thread on screen may be written to storage.
 *
 * Nothing is written while the read is in flight. Once it settles a write
 * proceeds, except after a read that failed: the selection the hook holds is then
 * the untouched one, and writing it would erase what is still stored, so that
 * first write waits for a change. Persistence itself does not stop — the change
 * that arrives, and every change after it, is written — so a transient failure
 * only delays the write-back instead of ending it for the session.
 */
export const shouldWriteSelection = (
  load: SelectionLoad | undefined,
  changed: boolean,
): boolean => load !== undefined && (load !== 'failed' || changed);
