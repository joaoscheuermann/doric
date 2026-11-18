import { createStore } from 'zustand/vanilla';

/**
 * The /projects dashboard's state, shared by its two slot elements
 * (`layout-sidebar`, which draws its sidebar, and `layout-dashboard`, which
 * draws its content), each a React root of its own.
 * - `active` (`layout.dashboard/v1`): the id of the `layout.dashboard.page`
 *   item drawn instead of the project list, absent while the list shows.
 *   Showing the shown page or closing a closed one changes nothing, so no
 *   subscriber hears it.
 * - `search` and `highlightedId`: the "Search projects" query and the
 *   Project the keyboard highlights in its results.
 * - `creating` and `createRequest`: whether the create form is open, and how
 *   many times it was asked for, so that every request focuses its field.
 */
export type DashboardState = {
  readonly active?: string;
  readonly search: string;
  readonly highlightedId: string | null;
  readonly creating: boolean;
  readonly createRequest: number;
  show(id: string): void;
  close(): void;
  setSearch(search: string): void;
  setHighlightedId(id: string | null): void;
  setCreating(creating: boolean): void;
  /** Opens the create form and counts the request. */
  requestCreate(): void;
};

export const dashboardStore = createStore<DashboardState>()((set) => ({
  search: '',
  highlightedId: null,
  creating: false,
  createRequest: 0,
  show: (active) =>
    set((state) => (state.active === active ? state : { active })),
  close: () =>
    set((state) =>
      state.active === undefined ? state : { active: undefined },
    ),
  setSearch: (search) => set({ search }),
  setHighlightedId: (highlightedId) => set({ highlightedId }),
  setCreating: (creating) => set({ creating }),
  requestCreate: () =>
    set((state) => ({
      creating: true,
      createRequest: state.createRequest + 1,
    })),
}));

/** Closes the page and clears the search and the create form. */
export const resetDashboard = (): void => {
  dashboardStore.getState().close();
  dashboardStore.setState({ search: '', highlightedId: null, creating: false });
};
