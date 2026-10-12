import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'desktop-ui/sonner';
import { useCallback } from 'react';

import { threadsApi } from '../api/threads-api.js';
import { messageFrom } from '../domain/errors.js';
import type { Thread } from '../domain/workspace.js';
import { queryKeys } from '../queries/keys.js';

/** The footer and Escape share one reader-stop contract. */
export const useThreadStop = (thread: Thread | undefined) => {
  const client = useQueryClient();
  const id = thread?.id;
  const promptId = thread?.activePromptId;
  return useCallback(() => {
    if (id === undefined || promptId === undefined) return;
    void threadsApi
      .interrupt(id, promptId)
      .then(() =>
        client.invalidateQueries({ queryKey: queryKeys.threadQueue(id) }),
      )
      .catch((error) => toast.error(messageFrom(error)));
  }, [client, id, promptId]);
};
