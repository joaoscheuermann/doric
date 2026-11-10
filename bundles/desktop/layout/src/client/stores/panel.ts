import { createStore } from 'zustand/vanilla';

/**
 * The Project panel beside the conversation (`layout.panel/v2`): which view
 * it shows. The panel is always shown, so there is no open state. It starts on
 * the Files view, and nothing is persisted: every window starts on Files.
 */
export type PanelState = {
  /** The selected `layout.panel` item id; it may name no registered item. */
  readonly active: string;
  /** Selects the view; selecting the selected view notifies no one. */
  select(id: string): void;
};

export const initialPanel = { active: 'files' } as const;

export const panelStore = createStore<PanelState>()((set) => ({
  ...initialPanel,
  select: (active) =>
    set((state) => (state.active === active ? state : { active })),
}));

export const resetPanel = (): void => {
  panelStore.setState(initialPanel);
};
