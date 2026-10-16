// A live agent terminal for the terminal block's stories: a `terminal/v1`
// stand-in that reports one running session of the story's Thread and its
// output so far, mounted under the conversation's Thread context the way the
// conversation mounts a terminal block. Stop ends the session.

import { type ReactNode, useEffect, useState } from 'react';

import type { ChatTerminalsApi } from '../../src/client/api/terminals-contract.js';
import { ConversationThreadContext } from '../../src/client/hooks/use-live-terminal.js';
import {
  retainProjectTerminals,
  setTerminalServiceApi,
} from '../../src/client/stores/live-terminals.js';
import { projectId, threadIds } from './fixtures.js';

const threadId = threadIds.running;

const terminalApi = (command: string, output: string): ChatTerminalsApi => {
  const terminal = {
    id: 'term-story-1',
    projectId,
    threadId,
    origin: 'agent' as const,
    command,
    cwd: '/workspace/storefront',
    startedAt: '2026-10-16T08:41:30.000Z',
    timeoutMs: null,
    state: 'running' as const,
    pty: false,
  };
  return {
    snapshot: async () => ({
      terminal,
      output,
      offset: output.length,
      truncated: false,
    }),
    stop: async () => true,
    watchProject: (_project, listener) => {
      const next = typeof listener === 'function' ? listener : listener.next;
      queueMicrotask(() =>
        next({ kind: 'snapshot', projectId, terminals: [terminal] }),
      );
      return { dispose: () => undefined };
    },
  };
};

export function LiveTerminal({
  command,
  output,
  children,
}: {
  /** The running command; the block matches its session by it. */
  readonly command: string;
  /** What the session has written so far. */
  readonly output: string;
  readonly children: ReactNode;
}) {
  const [context] = useState(() => ({ threadId, projectId }));
  useEffect(() => {
    setTerminalServiceApi(terminalApi(command, output));
    const release = retainProjectTerminals(projectId);
    return () => {
      release();
      setTerminalServiceApi(undefined);
    };
  }, [command, output]);
  return (
    <ConversationThreadContext.Provider value={context}>
      {children}
    </ConversationThreadContext.Provider>
  );
}
