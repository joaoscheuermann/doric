import { moveItem } from '../utility/move-item.js';

export type WorkspaceTab =
  | {
      readonly id: string;
      readonly kind: 'diff';
      readonly projectId: string;
      readonly repository: string;
      readonly path: string;
    }
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
    }
  /**
   * A tab another bundle opened through `layout.tabs/v1`: the element it
   * asked for, created by `ui/v1` and labelled with its title.
   */
  | {
      readonly id: string;
      readonly kind: 'element';
      readonly title: string;
      readonly element: object;
      readonly props?: Readonly<Record<string, unknown>>;
      /** `layout.tabs/v1@1.1.0`: the trigger's icon, aria label and tooltip. */
      readonly icon?: 'file' | 'file-diff' | 'terminal';
      readonly ariaLabel?: string;
      readonly tooltip?: string;
    };

/**
 * Whether a tab reads the Project's sandbox, which keeps the files and Git
 * refresh going: every tab but a terminal (built in, or an element tab with
 * the terminal icon).
 */
export const readsSandbox = (tab: WorkspaceTab): boolean =>
  tab.kind !== 'terminal' &&
  !(tab.kind === 'element' && tab.icon === 'terminal');

export type WorkspaceTabs = {
  readonly items: readonly WorkspaceTab[];
  readonly selected?: string;
  readonly manualId?: string;
  readonly manualIds?: readonly string[];
};

export const emptyTabs: WorkspaceTabs = { items: [] };

export const moveTab = (
  state: WorkspaceTabs,
  from: string,
  to: string,
): WorkspaceTabs => ({
  ...state,
  items: moveItem(
    state.items,
    state.items.findIndex((tab) => tab.id === from),
    state.items.findIndex((tab) => tab.id === to),
  ),
});

export const moveManualTab = (
  state: WorkspaceTabs,
  from: string,
  to: string,
): WorkspaceTabs => ({
  ...state,
  manualIds: moveItem(
    state.manualIds ?? [],
    state.manualIds?.indexOf(from) ?? -1,
    state.manualIds?.indexOf(to) ?? -1,
  ),
});

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
