import { createStore } from 'zustand/vanilla';

/**
 * The Project panel beside the conversation (`layout.panel/v3`): which view
 * it shows. The panel is always shown, so there is no open state. It starts
 * with no view, until `select` names one, and nothing is persisted.
 */
export type PanelState = {
  /** The selected `shell.panel` item id, if any; it may name no registered item. */
  readonly active: string | undefined;
  /** Selects the view; selecting the selected view notifies no one. */
  select(id: string): void;
};

export const initialPanel = { active: undefined } as const;

export const panelStore = createStore<PanelState>()((set) => ({
  ...initialPanel,
  select: (active) =>
    set((state) => (state.active === active ? state : { active })),
}));

export const resetPanel = (): void => {
  panelStore.setState(initialPanel);
};
