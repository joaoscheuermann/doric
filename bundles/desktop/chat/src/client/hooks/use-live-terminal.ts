import { createContext, useContext, useSyncExternalStore } from 'react';

import {
  type LiveTerminalSession,
  matchLiveTerminal,
  subscribeLiveTerminals,
} from '../stores/live-terminals.js';

export interface ConversationThreadInfo {
  readonly threadId: string;
  readonly projectId: string;
}

export const ConversationThreadContext =
  createContext<ConversationThreadInfo | null>(null);

export const useLiveTerminal = (input: {
  readonly command: string | undefined;
  readonly terminalId: string | undefined;
  readonly toolRunning: boolean;
}): LiveTerminalSession | undefined => {
  const thread = useContext(ConversationThreadContext);
  const threadId = thread?.threadId;

  return useSyncExternalStore(
    subscribeLiveTerminals,
    () =>
      matchLiveTerminal({
        threadId,
        command: input.command,
        terminalId: input.terminalId,
        toolRunning: input.toolRunning,
      }),
    () => undefined,
  );
};
