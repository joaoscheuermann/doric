import type { TabMenuItem } from '../../contracts/index.js';
import { moveItem } from '../utility/move-item.js';

/**
 * A tab another bundle opened through `layout.tabs/v2`: the element it asked
 * for, created by `ui/v1` and labelled with its title.
 */
export type WorkspaceTab = {
  readonly id: string;
  readonly kind: 'element';
  /** The `ui/v1` tag the element was created from (`layout.tabs/v2` `open`). */
  readonly tag: string;
  readonly title: string;
  readonly element: object;
  readonly props?: Readonly<Record<string, unknown>>;
  /** The element drawn as the trigger's icon. */
  readonly iconTag?: string;
  /** The viewer card draws no bottom padding while it is selected. */
  readonly openBottom?: boolean;
  readonly ariaLabel?: string;
  readonly tooltip?: string;
  /** The entries above "Close tab" in its menu. */
  readonly menu?: readonly TabMenuItem[];
};

export type WorkspaceTabs = {
  readonly items: readonly WorkspaceTab[];
  readonly selected?: string;
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

/** Sets the title of the element tab `id`; any other tab is left as it is. */
export const retitleTab = (
  state: WorkspaceTabs,
  id: string,
  title: string,
): WorkspaceTabs => ({
  ...state,
  items: state.items.map((tab) =>
    tab.id === id && tab.kind === 'element' ? { ...tab, title } : tab,
  ),
});
