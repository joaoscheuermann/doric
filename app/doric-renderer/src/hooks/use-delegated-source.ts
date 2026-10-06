import { useStore } from 'zustand';

import { threadLabel } from '@/domain/delegated';
import { workspaceStore } from '@/stores/workspace';

/** Resolve a sender from the already loaded tree without opening a subscription. */
export function useDelegatedSource(threadId: string) {
  const thread = useStore(workspaceStore, (state) =>
    Object.values(state.tree.threadsByProject)
      .flat()
      .find((candidate) => candidate.id === threadId),
  );
  const selectThread = useStore(workspaceStore, (state) => state.selectThread);
  return {
    label: threadLabel(threadId, thread?.name),
    open: thread === undefined ? undefined : () => selectThread(thread),
  };
}
