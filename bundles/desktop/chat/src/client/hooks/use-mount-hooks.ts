import { useEffect } from 'react';

import { chatHooks } from '../services/chat-hooks.js';

const observe = (run: () => Promise<unknown> | undefined): void => {
  try {
    void run()?.catch(() => undefined);
  } catch {
    // An observer is never a conversation failure.
  }
};

/**
 * `chat.hooks/v1` `onMountHook` when a conversation opens on a Thread, and
 * `onUnmountHook` when it closes or moves to another Thread.
 */
export const useMountHooks = (projectId: string, threadId: string): void => {
  useEffect(() => {
    observe(() => chatHooks()?.onMountHook.execute({ projectId, threadId }));
    return () => {
      observe(() =>
        chatHooks()?.onUnmountHook.execute({ projectId, threadId }),
      );
    };
  }, [projectId, threadId]);
};
