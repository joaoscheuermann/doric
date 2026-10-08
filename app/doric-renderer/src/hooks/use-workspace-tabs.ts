import { useStore } from 'zustand/react';

import { emptyTabs } from '@/domain/workspace-tabs';
import { workspaceTabsStore } from '@/stores/workspace-tabs';

export const useWorkspaceTabs = (threadId?: string) =>
  useStore(workspaceTabsStore, (state) =>
    threadId ? (state.threads[threadId] ?? emptyTabs) : emptyTabs,
  );
