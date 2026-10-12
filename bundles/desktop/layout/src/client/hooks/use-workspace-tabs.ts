import { useStore } from 'zustand/react';

import { emptyTabs } from '../domain/workspace-tabs.js';
import { workspaceTabsStore } from '../stores/workspace-tabs.js';

export const useWorkspaceTabs = (threadId?: string) =>
  useStore(workspaceTabsStore, (state) =>
    threadId ? (state.threads[threadId] ?? emptyTabs) : emptyTabs,
  );
