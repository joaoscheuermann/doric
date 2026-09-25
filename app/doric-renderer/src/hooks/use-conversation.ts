import type { ConversationActions } from '@/components/molecules/conversation-actions';
import {
  type ConversationTurn,
  conversationTurns,
} from '@/domain/conversation';
import type { Thread } from '@/domain/workspace';
import { useThreadChat } from '@/hooks/use-thread-chat';
import { useCallback, useMemo, useState } from 'react';

/** What the conversation surface reads and the one thing it can do. */
export type Conversation = {
  readonly turns: readonly ConversationTurn[];
  readonly actions: ConversationActions;
  /** A subscription or send failure, which the surface is expected to show. */
  readonly error: string | undefined;
  /**
   * How many prompts have been accepted. The document reads it to know when the
   * composer must be emptied — the one write the surface makes in the person's
   * own words, and only after they were sent.
   */
  readonly clear: number;
  /**
   * How many finished `write`, `edit` or `terminal` calls the log holds: the
   * signal that the sandbox the Thread shares has changed.
   */
  readonly writes: number;
};

/**
 * The conversation's own state, and the only place it is decided: which turns the
 * log renders, what the composer sends, and when the composer is emptied. It
 * renders nothing — the surface reads it and the document follows it.
 */
export const useConversation = (thread: Thread): Conversation => {
  const chat = useThreadChat(thread);
  const [clear, setClear] = useState(0);

  const submit = useCallback(
    (markdown: string): void => {
      if (chat.sending || markdown.trim().length === 0) return;
      void chat.prompt(markdown).then((accepted) => {
        if (accepted) setClear((count) => count + 1);
      });
    },
    [chat],
  );

  const actions = useMemo<ConversationActions>(
    () => ({ sending: chat.sending, submit }),
    [chat.sending, submit],
  );
  const turns = useMemo(() => conversationTurns(chat.turns), [chat.turns]);

  return {
    actions,
    clear,
    error: chat.sendError ?? chat.error,
    turns,
    writes: chat.writes,
  };
};
