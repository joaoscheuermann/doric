// The comments of one Thread on their way to the log: the ones the prompt in
// flight carries and the ones sent with an accepted prompt that the log does
// not hold yet. The stack above the prompt leaves them to the sent turn, which
// draws them from the send on, so a comment is never drawn twice.

import { useMemo } from 'react';
import { useStore } from 'zustand/react';

import { threadChatsStore } from '../stores/thread-chats.js';

/** The ids of the Thread's comments being sent. */
export const useSendingComments = (threadId: string): ReadonlySet<string> => {
  const pending = useStore(
    threadChatsStore,
    (state) => state.chats.chats.get(threadId)?.pending,
  );
  const outbox = useStore(
    threadChatsStore,
    (state) => state.chats.chats.get(threadId)?.outbox,
  );
  return useMemo(
    () =>
      new Set([
        ...(pending?.comments ?? []).map((comment) => comment.commentId),
        ...(outbox ?? []).map((sent) => sent.comment.commentId),
      ]),
    [pending, outbox],
  );
};
