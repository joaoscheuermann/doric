import { useQueryClient } from '@tanstack/react-query';
import { useCallback } from 'react';
import { toast } from 'sonner';

import { messageFrom, type Thread } from '@/domain/workspace';
import { queryKeys } from '@/queries/keys';

/** The footer and Escape share one reader-stop contract. */
export const useThreadStop = (thread: Thread | undefined) => {
  const client = useQueryClient();
  const id = thread?.id;
  const promptId = thread?.activePromptId;
  return useCallback(() => {
    if (id === undefined || promptId === undefined) return;
    void window.doric.threads
      .interrupt(id, promptId)
      .then(() =>
        client.invalidateQueries({ queryKey: queryKeys.threadQueue(id) }),
      )
      .catch((error) => toast.error(messageFrom(error)));
  }, [client, id, promptId]);
};
