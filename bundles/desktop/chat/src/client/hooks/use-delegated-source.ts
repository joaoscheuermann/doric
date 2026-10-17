import { NavigationV1 } from 'bundle/contracts';

import { threadLabel } from '../domain/delegated.js';
import { threadPath } from '../domain/thread-route.js';
import { chatServices } from '../services/chat-services.js';
import { useWorkspaceThread } from './use-workspace.js';

/**
 * Resolve a sender from the already loaded tree without opening a
 * subscription. Opening it navigates to its conversation, which selects it
 * (the layout follows the route).
 */
export function useDelegatedSource(threadId: string) {
  const thread = useWorkspaceThread(threadId);
  return {
    label: threadLabel(threadId, thread?.name),
    open:
      thread === undefined
        ? undefined
        : () =>
            chatServices()
              .use(NavigationV1)
              .navigate(threadPath(thread.projectId, thread.id)),
  };
}
