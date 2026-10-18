// Tracks live agent terminal sessions and their streaming output for any
// Project with an active conversation view, over `terminal/v1` or
// `runtime.terminals/v1`.

import type { Disposable } from 'bundle/contracts';

import type {
  ChatTerminalsApi,
  Terminal,
  TerminalWatchItem,
} from '../api/terminals-contract.js';

export interface LiveTerminalSession {
  readonly terminal: Terminal;
  readonly output: string;
  readonly offset: number;
}

/** Only the unseen suffix of a replayed or live UTF-16 output chunk is appended. */
export const unseenTerminalOutput = (
  data: string,
  offset: number,
  seen: number,
): string =>
  offset <= seen ? '' : data.slice(Math.max(0, seen - (offset - data.length)));

const MAX_LIVE_OUTPUT_CHARS = 32_000;
const OUTPUT_THROTTLE_MS = 50;

const trimOutput = (value: string): string =>
  value.length > MAX_LIVE_OUTPUT_CHARS
    ? value.slice(-MAX_LIVE_OUTPUT_CHARS)
    : value;

let terminalServiceProvider: ChatTerminalsApi | undefined;
let runtimeTerminalsProvider: ChatTerminalsApi | undefined;

const currentApi = (): ChatTerminalsApi | undefined =>
  terminalServiceProvider ?? runtimeTerminalsProvider;

const sessions = new Map<string, LiveTerminalSession>();
const projectRefCounts = new Map<string, number>();
const projectStreams = new Map<string, Disposable>();
const snapshotRequested = new Set<string>();
const listeners = new Set<() => void>();
let lastOutputNotifyAt = 0;
let pendingOutputTimer: ReturnType<typeof setTimeout> | null = null;

const notify = (): void => {
  if (pendingOutputTimer !== null) {
    clearTimeout(pendingOutputTimer);
    pendingOutputTimer = null;
  }
  lastOutputNotifyAt = Date.now();
  for (const listener of [...listeners]) listener();
};

const notifyOutput = (): void => {
  const now = Date.now();
  const elapsed = now - lastOutputNotifyAt;
  if (elapsed >= OUTPUT_THROTTLE_MS) {
    notify();
    return;
  }
  if (pendingOutputTimer === null) {
    pendingOutputTimer = setTimeout(() => {
      pendingOutputTimer = null;
      notify();
    }, OUTPUT_THROTTLE_MS - elapsed);
  }
};

const requestInitialSnapshot = (terminal: Terminal): void => {
  if (terminal.origin !== 'agent') return;
  if (snapshotRequested.has(terminal.id)) return;
  const api = currentApi();
  if (api === undefined) return;
  snapshotRequested.add(terminal.id);
  void api
    .snapshot(terminal.id, 0)
    .then((snap) => {
      if (snap === undefined) return;
      const existing = sessions.get(terminal.id);
      const baseTerminal = existing?.terminal ?? snap.terminal;
      const seen = existing?.offset ?? 0;
      const delta = unseenTerminalOutput(snap.output, snap.offset, seen);
      const nextOutput =
        seen === 0
          ? snap.output
          : delta.length > 0
            ? `${existing?.output ?? ''}${delta}`
            : (existing?.output ?? '');
      const nextOffset = Math.max(seen, snap.offset);
      sessions.set(terminal.id, {
        terminal: baseTerminal,
        output: trimOutput(nextOutput),
        offset: nextOffset,
      });
      notifyOutput();
    })
    .catch(() => undefined);
};

const handleWatchItem = (item: TerminalWatchItem): void => {
  if (item.kind === 'snapshot') {
    const incomingIds = new Set<string>();
    for (const terminal of item.terminals) {
      incomingIds.add(terminal.id);
      const existing = sessions.get(terminal.id);
      sessions.set(terminal.id, {
        terminal,
        output: existing?.output ?? '',
        offset: existing?.offset ?? 0,
      });
      requestInitialSnapshot(terminal);
    }
    for (const [id, session] of sessions) {
      if (
        session.terminal.projectId === item.projectId &&
        !incomingIds.has(id) &&
        session.terminal.state !== 'exited'
      ) {
        sessions.set(id, {
          ...session,
          terminal: { ...session.terminal, state: 'exited' },
        });
      }
    }
    notify();
    return;
  }

  if (item.kind === 'updated') {
    const existing = sessions.get(item.terminal.id);
    sessions.set(item.terminal.id, {
      terminal: item.terminal,
      output: existing?.output ?? '',
      offset: existing?.offset ?? 0,
    });
    requestInitialSnapshot(item.terminal);
    notify();
    return;
  }

  if (item.kind === 'removed') {
    const existing = sessions.get(item.terminalId);
    if (existing !== undefined && existing.terminal.state !== 'exited') {
      sessions.set(item.terminalId, {
        ...existing,
        terminal: { ...existing.terminal, state: 'exited' },
      });
      notify();
    }
    return;
  }

  if (item.kind === 'output') {
    const { terminalId, data, offset } = item.output;
    const existing = sessions.get(terminalId);
    if (existing === undefined) return;
    const delta = unseenTerminalOutput(data, offset, existing.offset);
    if (delta.length === 0 && offset <= existing.offset) return;
    sessions.set(terminalId, {
      ...existing,
      output: trimOutput(`${existing.output}${delta}`),
      offset: Math.max(existing.offset, offset),
    });
    notifyOutput();
  }
};

const openStream = (projectId: string): void => {
  if (projectStreams.has(projectId)) return;
  const api = currentApi();
  if (api === undefined) return;
  try {
    const stream = api.watchProject(projectId, {
      next: (item) => handleWatchItem(item),
    });
    projectStreams.set(projectId, stream);
  } catch {
    // Provider unavailable or leaving.
  }
};

const closeStream = (projectId: string): void => {
  const stream = projectStreams.get(projectId);
  projectStreams.delete(projectId);
  try {
    stream?.dispose();
  } catch {
    // Already closed.
  }
};

const restartAllStreams = (): void => {
  for (const projectId of [...projectStreams.keys()]) {
    closeStream(projectId);
  }
  snapshotRequested.clear();
  for (const [projectId, count] of projectRefCounts) {
    if (count > 0) openStream(projectId);
  }
  notify();
};

export const setTerminalServiceApi = (
  next: ChatTerminalsApi | undefined,
): void => {
  terminalServiceProvider = next;
  restartAllStreams();
};

export const setRuntimeTerminalsApi = (
  next: ChatTerminalsApi | undefined,
): void => {
  runtimeTerminalsProvider = next;
  restartAllStreams();
};

export const retainProjectTerminals = (projectId: string): (() => void) => {
  const count = (projectRefCounts.get(projectId) ?? 0) + 1;
  projectRefCounts.set(projectId, count);
  openStream(projectId);
  return () => {
    const current = projectRefCounts.get(projectId) ?? 0;
    if (current <= 1) {
      projectRefCounts.delete(projectId);
      closeStream(projectId);
    } else {
      projectRefCounts.set(projectId, current - 1);
    }
  };
};

export const subscribeLiveTerminals = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

export const stopLiveTerminal = (terminalId: string): void => {
  const existing = sessions.get(terminalId);
  if (existing !== undefined && existing.terminal.state !== 'exited') {
    sessions.set(terminalId, {
      ...existing,
      terminal: { ...existing.terminal, state: 'exited' },
    });
    notify();
  }
  const api = currentApi();
  if (api === undefined) return;
  void api.stop(terminalId).catch(() => undefined);
};

/**
 * Finds the live agent terminal session matching a `terminal` tool block:
 * - By exact `terminalId` when known (e.g. background terminal result).
 * - Otherwise, while the tool call is `running` on `threadId`, matches the
 *   newest active (or most recently started) agent session on that Thread whose
 *   command matches.
 */
export const matchLiveTerminal = (input: {
  readonly threadId: string | undefined;
  readonly command: string | undefined;
  readonly terminalId: string | undefined;
  readonly toolRunning: boolean;
}): LiveTerminalSession | undefined => {
  if (input.terminalId !== undefined) {
    return sessions.get(input.terminalId);
  }
  if (!input.toolRunning || input.threadId === undefined) {
    return undefined;
  }
  let bestActive: LiveTerminalSession | undefined;
  let bestAny: LiveTerminalSession | undefined;
  for (const session of sessions.values()) {
    const { terminal } = session;
    if (terminal.origin !== 'agent' || terminal.threadId !== input.threadId) {
      continue;
    }
    if (input.command !== undefined && terminal.command !== input.command) {
      continue;
    }
    bestAny = session;
    if (terminal.state !== 'exited') {
      bestActive = session;
    }
  }
  return bestActive ?? bestAny;
};

export const resetLiveTerminalsStore = (): void => {
  if (pendingOutputTimer !== null) {
    clearTimeout(pendingOutputTimer);
    pendingOutputTimer = null;
  }
  lastOutputNotifyAt = 0;
  for (const projectId of [...projectStreams.keys()]) {
    closeStream(projectId);
  }
  projectRefCounts.clear();
  sessions.clear();
  snapshotRequested.clear();
  terminalServiceProvider = undefined;
  runtimeTerminalsProvider = undefined;
};
