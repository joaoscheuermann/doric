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
  /** Sets an element tab's title (`layout.tabs/v1@1.2.0` `retitle`). */
  retitle(threadId: string, id: string, title: string): void;
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
  retitle: (threadId, id, title) =>
    set((state) => ({
      threads: {
        ...state.threads,
        [threadId]: retitleTab(state.threads[threadId] ?? emptyTabs, id, title),
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
