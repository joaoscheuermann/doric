export type WorkspaceTab =
  | {
      readonly id: string;
      readonly kind: 'file';
      readonly path: string;
      readonly projectId: string;
    }
  | {
      readonly id: string;
      readonly kind: 'terminal';
      readonly terminalId: string;
    };

export type WorkspaceTabs = {
  readonly items: readonly WorkspaceTab[];
  readonly selected?: string;
  readonly manualId?: string;
  readonly manualIds?: readonly string[];
};

export const emptyTabs: WorkspaceTabs = { items: [] };

export const openManual = (
  state: WorkspaceTabs,
  id?: string,
): WorkspaceTabs => ({
  ...state,
  manualId: id,
  manualIds:
    id === undefined || state.manualIds?.includes(id)
      ? state.manualIds
      : [...(state.manualIds ?? []), id],
});

export const closeManual = (
  state: WorkspaceTabs,
  id: string,
): WorkspaceTabs => {
  const manualIds = state.manualIds?.filter((item) => item !== id);
  return {
    ...state,
    manualIds,
    manualId: state.manualId === id ? manualIds?.at(-1) : state.manualId,
  };
};

export const openTab = (
  state: WorkspaceTabs,
  tab: WorkspaceTab,
): WorkspaceTabs => ({
  ...state,
  items: state.items.some((item) => item.id === tab.id)
    ? state.items
    : [...state.items, tab],
  selected: tab.id,
});

export const closeTab = (state: WorkspaceTabs, id: string): WorkspaceTabs => {
  const items = state.items.filter((item) => item.id !== id);
  return {
    ...state,
    items,
    selected: state.selected === id ? items.at(-1)?.id : state.selected,
  };
};

export const removeTerminal = (
  state: WorkspaceTabs,
  terminalId: string,
): WorkspaceTabs => {
  const tab = state.items.find(
    (item) => item.kind === 'terminal' && item.terminalId === terminalId,
  );
  return closeManual(tab ? closeTab(state, tab.id) : state, terminalId);
};
