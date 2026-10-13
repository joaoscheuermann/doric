// The window's terminal state (moved from the layout's provisional
// `useTerminals`): each followed Project's terminal list, kept by
// `terminal/v1.watchProject`. A terminal that leaves its Project's list closes its
// workspace tab; a change of a Project's terminal activity
// (id, state, command, cwd) asks the files bundle to refresh that Project.

import type { Disposable } from 'bundle/contracts';

import type { TerminalApi } from './api.js';
import type { Terminal, TerminalUpdate } from './domain/terminals.js';

/** The message of a failure, as the renderer's `messageFrom` read it. */
export const messageFrom = (error: unknown): string =>
  error instanceof Error
    ? error.message
    : 'The operation could not be completed.';

export interface TerminalStoreOptions {
  readonly api: TerminalApi;
  readonly watchProject: (
    projectId: string,
    listener: (update: TerminalUpdate) => void,
  ) => () => void;
  /** Shows a failure the way the renderer's `toast.error` did. */
  readonly toastError: (message: string) => void;
  /** Opens a shell in the same workspace tab area as files and diffs. */
  readonly openTerminal: (terminal: Terminal) => Promise<void>;
  /** Closes the workspace tab `terminal:<id>` of the terminal's Thread. */
  readonly closeTab: (input: {
    readonly id: string;
    readonly threadId: string;
  }) => void;
  /** `files.refresh/v1.request`, while the files bundle serves it. */
  readonly refreshFiles: (projectId: string) => void;
}

export interface TerminalStore {
  /** Starts following a Project's terminals; idempotent. */
  follow(projectId: string): void;
  /** Stops following a Project and forgets its list. */
  unfollow(projectId: string): void;
  /** Every followed Project's terminals. */
  terminals(): readonly Terminal[];
  /** A Thread's terminals, in list order. */
  threadTerminals(threadId: string): readonly Terminal[];
  /** Opens a manual shell on the Thread and shows it; failures are toasts. */
  create(threadId: string): Promise<void>;
  /** Stops or discards a terminal; failures are toasts. */
  stop(id: string): void;
  subscribe(listener: () => void): Disposable;
  dispose(): void;
}

const upsertLast = (
  values: readonly Terminal[],
  value: Terminal,
): readonly Terminal[] => {
  const index = values.findIndex((candidate) => candidate.id === value.id);
  if (index === -1) return [...values, value];
  return values.map((candidate, candidateIndex) =>
    candidateIndex === index ? value : candidate,
  );
};

const activity = (terminals: readonly Terminal[]): string =>
  JSON.stringify(
    terminals.map(({ id, state, command, cwd }) => [id, state, command, cwd]),
  );

export const createTerminalStore = (
  options: TerminalStoreOptions,
): TerminalStore => {
  const lists = new Map<string, readonly Terminal[]>();
  const watches = new Map<string, () => void>();
  const listeners = new Set<() => void>();
  let all: readonly Terminal[] = [];

  const changed = () => {
    all = [...lists.values()].flat();
    for (const listener of [...listeners]) listener();
  };

  const removed = (terminal: Pick<Terminal, 'id' | 'threadId'>) => {
    options.closeTab({
      id: `terminal:${terminal.id}`,
      threadId: terminal.threadId,
    });
  };

  const setList = (projectId: string, next: readonly Terminal[]) => {
    const previous = lists.get(projectId) ?? [];
    lists.set(projectId, next);
    if (activity(previous) !== activity(next)) options.refreshFiles(projectId);
    changed();
  };

  const apply = (projectId: string, update: TerminalUpdate) => {
    if (update.kind === 'error') {
      options.toastError(update.message);
      return;
    }
    const previous = lists.get(projectId) ?? [];
    if (update.kind === 'snapshot') {
      for (const terminal of previous) {
        if (!update.terminals.some((item) => item.id === terminal.id))
          removed(terminal);
      }
      setList(projectId, update.terminals);
      return;
    }
    if (update.kind === 'removed') {
      const terminal = previous.find((item) => item.id === update.terminalId);
      if (terminal !== undefined) removed(terminal);
      setList(
        projectId,
        previous.filter((item) => item.id !== update.terminalId),
      );
      return;
    }
    setList(projectId, upsertLast(previous, update.terminal));
  };

  return {
    follow: (projectId) => {
      if (watches.has(projectId)) return;
      watches.set(
        projectId,
        options.watchProject(projectId, (update) => apply(projectId, update)),
      );
    },
    unfollow: (projectId) => {
      watches.get(projectId)?.();
      watches.delete(projectId);
      if (lists.delete(projectId)) changed();
    },
    terminals: () => all,
    threadTerminals: (threadId) =>
      all.filter((terminal) => terminal.threadId === threadId),
    create: async (threadId) => {
      try {
        const terminal = await options.api.create(threadId);
        setList(
          terminal.projectId,
          upsertLast(lists.get(terminal.projectId) ?? [], terminal),
        );
        await options.openTerminal(terminal);
      } catch (error) {
        options.toastError(messageFrom(error));
      }
    },
    stop: (id) => {
      void options.api
        .stop(id)
        .catch((error: unknown) => options.toastError(messageFrom(error)));
    },
    subscribe: (listener) => {
      const entry = () => listener();
      listeners.add(entry);
      return { dispose: () => listeners.delete(entry) };
    },
    dispose: () => {
      for (const stop of watches.values()) stop();
      watches.clear();
      lists.clear();
      listeners.clear();
      all = [];
    },
  };
};
