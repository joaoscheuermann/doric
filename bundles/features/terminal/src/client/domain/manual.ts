// The manual terminals of one Thread (moved from the layout's
// `domain/workspace-tabs.ts`, manual part): the open shells in tab order and
// the shown one; no shown shell hides the bottom section.

export type ManualTerminals = {
  readonly manualId?: string;
  readonly manualIds?: readonly string[];
};

export const emptyManual: ManualTerminals = {};

/** Move an existing item to another existing position without mutating the list. */
export function moveItem<T>(
  items: readonly T[],
  from: number,
  to: number,
): readonly T[] {
  if (
    from === to ||
    from < 0 ||
    to < 0 ||
    from >= items.length ||
    to >= items.length
  )
    return items;
  const result = [...items];
  result.splice(to, 0, ...result.splice(from, 1));
  return result;
}

export const moveManualTab = (
  state: ManualTerminals,
  from: string,
  to: string,
): ManualTerminals => ({
  ...state,
  manualIds: moveItem(
    state.manualIds ?? [],
    state.manualIds?.indexOf(from) ?? -1,
    state.manualIds?.indexOf(to) ?? -1,
  ),
});

/** Shows the shell `id` (adding it last), or hides the section without one. */
export const openManual = (
  state: ManualTerminals,
  id?: string,
): ManualTerminals => ({
  ...state,
  manualId: id,
  manualIds:
    id === undefined || state.manualIds?.includes(id)
      ? state.manualIds
      : [...(state.manualIds ?? []), id],
});

export const closeManual = (
  state: ManualTerminals,
  id: string,
): ManualTerminals => {
  const manualIds = state.manualIds?.filter((item) => item !== id);
  return {
    ...state,
    manualIds,
    manualId: state.manualId === id ? manualIds?.at(-1) : state.manualId,
  };
};
