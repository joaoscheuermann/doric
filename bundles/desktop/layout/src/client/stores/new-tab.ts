import { createStore } from 'zustand/vanilla';

/**
 * Whether the home path `/` was opened through the tab bar's "New project".
 * It lives outside `<layout-workspace>` because the core outlet mounts a new
 * workspace when the route moves between `/projects` and `/`, and the flag
 * must survive that remount within one layout activation.
 */
export type NewTabState = {
  readonly open: boolean;
  set(open: boolean): void;
};

export const newTabStore = createStore<NewTabState>()((set) => ({
  open: false,
  set: (open) => set((state) => (state.open === open ? state : { open })),
}));

export const resetNewTab = (): void => {
  newTabStore.getState().set(false);
};
