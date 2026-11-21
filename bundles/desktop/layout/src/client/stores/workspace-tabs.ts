import { createStore } from 'zustand/vanilla';

import {
  closeTab,
  emptyTabs,
  moveTab,
  openTab,
  retitleTab,
  type WorkspaceTab,
  type WorkspaceTabs,
} from '../domain/workspace-tabs.js';

type TabsState = {
  readonly threads: Readonly<Record<string, WorkspaceTabs>>;
  open(threadId: string, tab: WorkspaceTab): void;
  close(threadId: string, id: string): void;
  select(threadId: string, id: string): void;
  /** Sets an element tab's title (`layout.tabs/v2` `retitle`). */
  retitle(threadId: string, id: string, title: string): void;
  move(threadId: string, from: string, to: string): void;
  /**
   * The owner whose tabs the frame shows: a Thread id or `project:<id>`;
   * absent, no set (`layout.tabs/v2` `setOwner`).
   */
  readonly owner?: string;
  /** Names the owner; setting the current owner again notifies no one. */
  setOwner(owner?: string): void;
  /** Closes the tab `id` in every owner; answers the removed tabs. */
  closeEverywhere(id: string): WorkspaceTab[];
  /** Sets the title of the element tab `id` in every owner. */
  retitleEverywhere(id: string, title: string): void;
};

const holds = (tabs: WorkspaceTabs, id: string): boolean =>
  tabs.items.some((tab) => tab.id === id);

export const workspaceTabsStore = createStore<TabsState>()((set, get) => ({
  threads: {},
  setOwner: (owner) =>
    set((state) => (state.owner === owner ? state : { owner })),
  closeEverywhere: (id) => {
    const removed = Object.values(get().threads).flatMap((tabs) =>
      tabs.items.filter((tab) => tab.id === id),
    );
    if (removed.length === 0) return removed;
    set((state) => ({
      threads: Object.fromEntries(
        Object.entries(state.threads).map(([owner, tabs]) => [
          owner,
          holds(tabs, id) ? closeTab(tabs, id) : tabs,
        ]),
      ),
    }));
    return removed;
  },
  retitleEverywhere: (id, title) =>
    set((state) => ({
      threads: Object.fromEntries(
        Object.entries(state.threads).map(([owner, tabs]) => [
          owner,
          holds(tabs, id) ? retitleTab(tabs, id, title) : tabs,
        ]),
      ),
    })),
  move: (threadId, from, to) =>
    set((state) => ({
      threads: {
        ...state.threads,
        [threadId]: moveTab(state.threads[threadId] ?? emptyTabs, from, to),
      },
    })),
  open: (threadId, tab) =>
    set((state) => ({
      threads: {
        ...state.threads,
        [threadId]: openTab(state.threads[threadId] ?? emptyTabs, tab),
      },
    })),
  close: (threadId, id) =>
    set((state) => ({
      threads: {
        ...state.threads,
        [threadId]: closeTab(state.threads[threadId] ?? emptyTabs, id),
      },
    })),
  retitle: (threadId, id, title) =>
    set((state) => ({
      threads: {
        ...state.threads,
        [threadId]: retitleTab(state.threads[threadId] ?? emptyTabs, id, title),
      },
    })),
  // Reselecting the selected tab (reopening it through `layout.tabs/v2`)
  // changes nothing, so it notifies no one.
  select: (threadId, id) =>
    set((state) =>
      state.threads[threadId]?.selected === id
        ? state
        : {
            threads: {
              ...state.threads,
              [threadId]: {
                ...(state.threads[threadId] ?? emptyTabs),
                selected: id,
              },
            },
          },
    ),
}));
