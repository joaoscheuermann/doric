import { createStore } from 'zustand/vanilla';

/**
 * The Project panel beside the conversation (`layout.panel/v1`): whether it
 * is open and which view it shows. It starts open on the Files view and keeps
 * the reader's choice, as the panel always did.
 */
export type PanelState = {
  readonly open: boolean;
  readonly active: string;
  setOpen(open: boolean): void;
  select(id: string): void;
  /** Opens the panel and selects the view. */
  show(id: string): void;
  toggle(): void;
};

export const initialPanel = { open: true, active: 'files' } as const;

export const panelStore = createStore<PanelState>()((set) => ({
  ...initialPanel,
  setOpen: (open) => set((state) => (state.open === open ? state : { open })),
  select: (active) =>
    set((state) => (state.active === active ? state : { active })),
  show: (active) =>
    set((state) =>
      state.open && state.active === active ? state : { open: true, active },
    ),
  toggle: () => set((state) => ({ open: !state.open })),
}));

export const resetPanel = (): void => {
  panelStore.setState(initialPanel);
};
