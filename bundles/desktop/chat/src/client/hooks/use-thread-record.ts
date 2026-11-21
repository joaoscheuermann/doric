import { useEffect, useState } from 'react';

import { threadsApi } from '../api/threads-api.js';
import type { Thread } from '../domain/workspace.js';
import { useHasWorkspace, useWorkspaceThread } from './use-workspace.js';

/**
 * The record `<chat-view>` opens a conversation on (§7.4). While a
 * `workspace.selection/v1` provider answers it is the records' Thread
 * (`runtime.records/v1`), kept live as the records change, so the conversation
 * opens on exactly the record the selected row shows. Without one the host is
 * asked once per Thread; `undefined` until the record is known, and for a
 * Thread that does not exist.
 */
export const useThreadRecord = (threadId: string): Thread | undefined => {
  const hasWorkspace = useHasWorkspace();
  const fromTree = useWorkspaceThread(threadId);
  const [fetched, setFetched] = useState<
    { readonly id: string; readonly thread: Thread | undefined } | undefined
  >(undefined);

  useEffect(() => {
    if (hasWorkspace) return;
    let live = true;
    threadsApi.get(threadId).then(
      (thread) => {
        if (live) setFetched({ id: threadId, thread });
      },
      () => {
        if (live) setFetched({ id: threadId, thread: undefined });
      },
    );
    return () => {
      live = false;
    };
  }, [hasWorkspace, threadId]);

  if (hasWorkspace) return fromTree;
  return fetched?.id === threadId ? fetched.thread : undefined;
};
