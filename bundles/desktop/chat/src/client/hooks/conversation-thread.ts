// The Thread a conversation shows, for the blocks inside it that act on it
// (an attachment's image, a comment, a compaction or failure notice). Moved
// from `use-live-terminal.ts` when the chat stopped drawing live terminals
// (bundle isolation 5(b), S-1).

import { createContext } from 'react';

export interface ConversationThreadInfo {
  readonly threadId: string;
  readonly projectId: string;
}

export const ConversationThreadContext =
  createContext<ConversationThreadInfo | null>(null);
