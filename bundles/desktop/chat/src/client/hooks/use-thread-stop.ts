import { useQueryClient } from '@tanstack/react-query';
import { errorInfo } from 'desktop/reads';
import { toastError } from 'desktop/ui/error-notice';
import { useCallback } from 'react';

import { threadsApi } from '../api/threads-api.js';
import { chatErrorCatalog } from '../domain/error-catalog.js';
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
      .catch((error: unknown) =>
        toastError({
          id: `thread-stop-${id}`,
          error: errorInfo(error),
          catalog: chatErrorCatalog,
          fallbackCode: 'stop_failed',
          context: { Thread: id, Prompt: promptId },
        }),
      );
  }, [client, id, promptId]);
};
