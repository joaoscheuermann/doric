import { emptyTabs } from '@/domain/workspace-tabs';
import { workspaceTabsStore } from '@/stores/workspace-tabs';
import { useStore } from 'zustand/react';

export const useWorkspaceTabs = (threadId?: string) =>
  useStore(workspaceTabsStore, (state) =>
    threadId ? (state.threads[threadId] ?? emptyTabs) : emptyTabs,
  );
