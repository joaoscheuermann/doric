import {
  closeManual,
  closeTab,
  emptyTabs,
  moveManualTab,
  moveTab,
  openManual,
  openTab,
  removeTerminal,
  type WorkspaceTab,
  type WorkspaceTabs,
} from '@/domain/workspace-tabs';
import { createStore } from 'zustand/vanilla';

type TabsState = {
  readonly threads: Readonly<Record<string, WorkspaceTabs>>;
  open(threadId: string, tab: WorkspaceTab): void;
  close(threadId: string, id: string): void;
  select(threadId: string, id: string): void;
  manual(threadId: string, id?: string): void;
  closeManual(threadId: string, id: string): void;
  move(threadId: string, from: string, to: string): void;
  moveManual(threadId: string, from: string, to: string): void;
  remove(terminalId: string): void;
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
  moveManual: (threadId, from, to) =>
    set((state) => ({
      threads: {
        ...state.threads,
        [threadId]: moveManualTab(
          state.threads[threadId] ?? emptyTabs,
          from,
          to,
        ),
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
  select: (threadId, id) =>
    set((state) => ({
      threads: {
        ...state.threads,
        [threadId]: { ...(state.threads[threadId] ?? emptyTabs), selected: id },
      },
    })),
  manual: (threadId, id) =>
    set((state) => ({
      threads: {
        ...state.threads,
        [threadId]: openManual(state.threads[threadId] ?? emptyTabs, id),
      },
    })),
  closeManual: (threadId, id) =>
    set((state) => ({
      threads: {
        ...state.threads,
        [threadId]: closeManual(state.threads[threadId] ?? emptyTabs, id),
      },
    })),
  remove: (terminalId) =>
    set((state) => ({
      threads: Object.fromEntries(
        Object.entries(state.threads).map(([id, tabs]) => [
          id,
          removeTerminal(tabs, terminalId),
        ]),
      ),
    })),
}));
