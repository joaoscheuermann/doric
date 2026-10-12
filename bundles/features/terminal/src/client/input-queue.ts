// Keyboard input reaches the host in the order it was typed, per terminal
// (`app/doric/src/workspace/terminal-ipc.ts`, then the layout's provisional
// adapter): each write waits for the terminal's previous one, whatever its
// outcome, and the chain is dropped once it drains.

export interface InputQueue {
  /** Runs `write` after the terminal's earlier writes settled. */
  enqueue(terminalId: string, write: () => Promise<void>): Promise<void>;
}

export const createInputQueue = (): InputQueue => {
  const writes = new Map<string, Promise<void>>();

  return {
    enqueue: async (terminalId, write) => {
      const next = (writes.get(terminalId) ?? Promise.resolve())
        .catch(() => undefined)
        .then(write);
      writes.set(terminalId, next);
      try {
        await next;
      } finally {
        if (writes.get(terminalId) === next) writes.delete(terminalId);
      }
    },
  };
};
