import { createStore } from 'zustand/vanilla';

import {
  closeTab,
  emptyTabs,
  moveTab,
  openTab,
  type WorkspaceTab,
  type WorkspaceTabs,
} from '../domain/workspace-tabs.js';

type TabsState = {
  readonly threads: Readonly<Record<string, WorkspaceTabs>>;
  open(threadId: string, tab: WorkspaceTab): void;
  close(threadId: string, id: string): void;
  select(threadId: string, id: string): void;
  move(threadId: string, from: string, to: string): void;
};

export const workspaceTabsStore = createStore<TabsState>()((set) => ({
  threads: {},
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
  // Reselecting the selected tab (reopening it through `layout.tabs/v1`)
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
