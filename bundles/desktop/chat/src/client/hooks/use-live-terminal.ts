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

const noopSubscribe = (): (() => void) => () => {};

export const useLiveTerminal = (input: {
  readonly command: string | undefined;
  readonly terminalId: string | undefined;
  readonly toolRunning: boolean;
}): LiveTerminalSession | undefined => {
  const thread = useContext(ConversationThreadContext);
  const threadId = thread?.threadId;
  const canMatch = input.toolRunning || input.terminalId !== undefined;

  return useSyncExternalStore(
    canMatch ? subscribeLiveTerminals : noopSubscribe,
    () =>
      canMatch
        ? matchLiveTerminal({
            threadId,
            command: input.command,
            terminalId: input.terminalId,
            toolRunning: input.toolRunning,
          })
        : undefined,
    () => undefined,
  );
};
