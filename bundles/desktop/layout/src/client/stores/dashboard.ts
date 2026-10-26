import { createStore } from 'zustand/vanilla';

/**
 * The /projects dashboard's shown page (`layout.dashboard/v1`): the id of the
 * `layout.dashboard.page` item drawn instead of the project list, absent while
 * the list shows. Showing the shown page or closing a closed one changes
 * nothing, so no subscriber hears it.
 */
export type DashboardState = {
  readonly active?: string;
  show(id: string): void;
  close(): void;
};

export const dashboardStore = createStore<DashboardState>()((set) => ({
  show: (active) =>
    set((state) => (state.active === active ? state : { active })),
  close: () =>
    set((state) =>
      state.active === undefined ? state : { active: undefined },
    ),
}));

export const resetDashboard = (): void => {
  dashboardStore.getState().close();
};
