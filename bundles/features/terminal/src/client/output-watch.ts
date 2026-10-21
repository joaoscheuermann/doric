// The window's terminal streams (moved from the layout's provisional
// `terminals/api/terminal-watch.ts`, before that the main process's
// `workspace/terminal-events.ts` and the preload's `terminals` listeners),
// now over `terminal/v1.watchProject`.
//
// Project watch (`watchProject`): the terminal list of one Project.
// - A snapshot or update for another Project is dropped; a record that fails
//   the terminal check reports 'The terminal list could not be read.' or
//   'The terminal could not be read.'.
// - Output items are not part of the list.
//
// Output watch (`watch`): one terminal's output.
// - The terminal's snapshot is read first, only to learn its Project; a
//   failed read reports 'The terminal is no longer available.'.
// - The Project stream's snapshot (sent on every (re)subscribe) reads the
//   terminal snapshot again and sends it; output that arrives meanwhile is
//   buffered and replayed after it. A buffer above 2 097 152 characters reads
//   the snapshot again instead of growing.
// - Output is reconciled by offset: already seen output is dropped, a gap
//   reads the snapshot again, an overlap sends only the unseen tail.
// - A dropped connection bumps the generation (a snapshot read in flight is
//   ignored) and buffers again until the next snapshot.
//
// Both: one listener per Project or terminal, the newest replacing the older
// (the preload kept one listener per id). A dropped connection
// (`disconnected`, `unavailable`) or a lost host generation (`generation_lost`)
// reports nothing and subscribes again when the connection reports
// `connected`, or after one second when it never went down, as Socket.IO
// reconnected. Any other end of the stream reports
// 'The terminal connection failed.' (the socket's `connect_error`) and stays
// ended.

import {
  type ContractError,
  type Disposable,
  isContractError,
  type StreamObserver,
} from 'bundle/contracts';

import type { TerminalWatchItem } from '../contracts/index.js';
import { type TerminalSnapshotRead, terminalFrom } from './api.js';
import type {
  Terminal,
  TerminalOutputUpdate,
  TerminalUpdate,
} from './domain/terminals.js';

/** How long a stream that ended while connected waits to subscribe again. */
export const resubscribeDelayMs = 1000;

/** `doric.connection/v1`, as the watches read it. */
export interface ConnectionSource {
  status(): 'connected' | 'disconnected';
  subscribe(
    listener: (status: 'connected' | 'disconnected') => void,
  ): Disposable;
}

export type TerminalWatchApi = {
  watchProject(
    projectId: string,
    listener: (update: TerminalUpdate) => void,
  ): () => void;
  watch(
    id: string,
    afterSequence: number,
    listener: (update: TerminalOutputUpdate) => void,
  ): () => void;
};

export const terminalMessages = {
  listUnreadable: 'The terminal list could not be read.',
  terminalUnreadable: 'The terminal could not be read.',
  connectionFailed: 'The terminal connection failed.',
  gone: 'The terminal is no longer available.',
} as const;

/** The most output buffered while a snapshot is read. */
export const pendingOutputLimit = 2_097_152;

export interface TerminalStreamSource {
  watchProject(
    projectId: string,
    listener: StreamObserver<TerminalWatchItem>,
  ): Disposable;
}

export interface TerminalWatchOptions {
  readonly terminals: TerminalStreamSource;
  readonly snapshot: (id: string) => Promise<TerminalSnapshotRead>;
  readonly connection: ConnectionSource;
  readonly schedule?: (run: () => void, ms: number) => () => void;
}

export interface TerminalWatches extends TerminalWatchApi {
  /** Stops every watch. */
  close(): void;
}

const silent = (error: ContractError | undefined): boolean =>
  isContractError(error) &&
  ['disconnected', 'unavailable', 'generation_lost'].includes(error.code);

const defaultSchedule = (run: () => void, ms: number): (() => void) => {
  const timer = setTimeout(run, ms);
  return () => clearTimeout(timer);
};

/**
 * One reconnecting subscription to a Project's terminal stream. `onLost` runs
 * when the connection drops (before it subscribes again), `onFailed` when the
 * stream ends for another reason.
 */
const reconnecting = (
  options: TerminalWatchOptions,
  projectId: string,
  handlers: {
    readonly next: (item: TerminalWatchItem) => void;
    readonly onLost?: () => void;
    readonly onFailed: () => void;
  },
): (() => void) => {
  const schedule = options.schedule ?? defaultSchedule;
  let active = true;
  let stream: Disposable | undefined;
  let waiting: Disposable | undefined;
  let cancelTimer: (() => void) | undefined;

  const clearWaits = () => {
    waiting?.dispose();
    waiting = undefined;
    cancelTimer?.();
    cancelTimer = undefined;
  };

  const subscribe = () => {
    clearWaits();
    if (!active) return;
    let ended = false;
    const observer: StreamObserver<TerminalWatchItem> = {
      next: (item) => {
        if (active && !ended) handlers.next(item);
      },
      end: (error) => {
        if (!active || ended) return;
        ended = true;
        stream = undefined;
        if (silent(error)) {
          handlers.onLost?.();
          waitForConnection();
          return;
        }
        if (error !== undefined) handlers.onFailed();
      },
    };
    try {
      const opened = options.terminals.watchProject(projectId, observer);
      if (ended || !active) opened.dispose();
      else stream = opened;
    } catch (error) {
      observer.end?.(error as ContractError);
    }
  };

  const waitForConnection = () => {
    clearWaits();
    waiting = options.connection.subscribe((status) => {
      if (status === 'connected') subscribe();
    });
    if (options.connection.status() === 'connected') {
      cancelTimer = schedule(subscribe, resubscribeDelayMs);
    }
  };

  subscribe();
  return () => {
    if (!active) return;
    active = false;
    clearWaits();
    stream?.dispose();
    stream = undefined;
  };
};

export const createTerminalWatches = (
  options: TerminalWatchOptions,
): TerminalWatches => {
  const projectWatches = new Map<string, () => void>();
  const outputWatches = new Map<string, () => void>();

  const replace = (
    watches: Map<string, () => void>,
    key: string,
    stop: () => void,
  ) => {
    watches.get(key)?.();
    watches.set(key, stop);
  };

  const watchProject = (
    projectId: string,
    listener: (update: TerminalUpdate) => void,
  ): (() => void) => {
    let active = true;
    const send = (update: TerminalUpdate) => {
      if (active) listener(update);
    };
    const unsubscribe = reconnecting(options, projectId, {
      next: (item) => {
        if (item.kind === 'snapshot') {
          if (item.projectId !== projectId || !Array.isArray(item.terminals))
            return;
          let terminals: readonly Terminal[];
          try {
            terminals = item.terminals
              .map(terminalFrom)
              .filter((terminal) => terminal.projectId === projectId);
          } catch {
            send({ kind: 'error', message: terminalMessages.listUnreadable });
            return;
          }
          send({ kind: 'snapshot', terminals });
          return;
        }
        if (item.kind === 'updated') {
          if (item.terminal?.projectId !== projectId) return;
          let terminal: Terminal;
          try {
            terminal = terminalFrom(item.terminal);
          } catch {
            send({
              kind: 'error',
              message: terminalMessages.terminalUnreadable,
            });
            return;
          }
          send({ kind: 'updated', terminal });
          return;
        }
        if (
          item.kind === 'removed' &&
          item.projectId === projectId &&
          typeof item.terminalId === 'string'
        ) {
          send({ kind: 'removed', terminalId: item.terminalId });
        }
      },
      onFailed: () =>
        send({ kind: 'error', message: terminalMessages.connectionFailed }),
    });
    const stop = () => {
      if (!active) return;
      active = false;
      unsubscribe();
      if (projectWatches.get(projectId) === stop) {
        projectWatches.delete(projectId);
      }
    };
    replace(projectWatches, projectId, stop);
    return stop;
  };

  const watch = (
    id: string,
    _afterSequence: number,
    listener: (update: TerminalOutputUpdate) => void,
  ): (() => void) => {
    let active = true;
    let unsubscribe: (() => void) | undefined;
    let generation = 0;
    let cursor = 0;
    let pending: { data: string; offset: number }[] | undefined = [];
    let pendingLength = 0;

    const send = (update: TerminalOutputUpdate) => {
      if (active) listener(update);
    };
    const output = (chunk: { data: string; offset: number }) => {
      if (chunk.offset <= cursor) return;
      if (chunk.offset - chunk.data.length > cursor) {
        void refresh();
        return;
      }
      const data = chunk.data.slice(
        Math.max(0, cursor - (chunk.offset - chunk.data.length)),
      );
      cursor = chunk.offset;
      send({ kind: 'output', data, sequence: cursor });
    };
    const refresh = async () => {
      const attempt = ++generation;
      pending = [];
      pendingLength = 0;
      try {
        const snapshot = await options.snapshot(id);
        if (!active || attempt !== generation) return;
        cursor = snapshot.offset;
        send({
          kind: 'snapshot',
          data: snapshot.output,
          sequence: cursor,
          truncated: snapshot.truncated,
        });
        const chunks = pending;
        pending = undefined;
        chunks?.forEach(output);
      } catch {
        if (active && attempt === generation) {
          send({ kind: 'error', message: terminalMessages.gone });
        }
      }
    };

    void options
      .snapshot(id)
      .then((snapshot) => {
        if (!active) return;
        const projectId = snapshot.terminal.projectId;
        unsubscribe = reconnecting(options, projectId, {
          next: (item) => {
            if (item.kind === 'snapshot') {
              if (item.projectId === projectId) void refresh();
              return;
            }
            if (item.kind !== 'output') return;
            const chunk = item.output;
            if (
              chunk?.projectId !== projectId ||
              chunk.terminalId !== id ||
              typeof chunk.data !== 'string' ||
              !Number.isSafeInteger(chunk.offset) ||
              chunk.offset < chunk.data.length
            )
              return;
            const piece = { data: chunk.data, offset: chunk.offset };
            if (pending) {
              pending.push(piece);
              pendingLength += piece.data.length;
              // A slow snapshot must not let an unbounded output queue grow.
              if (pendingLength > pendingOutputLimit) void refresh();
            } else output(piece);
          },
          onLost: () => {
            generation++;
            pending = [];
          },
          onFailed: () =>
            send({ kind: 'error', message: terminalMessages.connectionFailed }),
        });
        if (!active) unsubscribe();
      })
      .catch(() => send({ kind: 'error', message: terminalMessages.gone }));

    const stop = () => {
      if (!active) return;
      active = false;
      generation++;
      unsubscribe?.();
      if (outputWatches.get(id) === stop) outputWatches.delete(id);
    };
    replace(outputWatches, id, stop);
    return stop;
  };

  return {
    watchProject,
    watch,
    close: () => {
      for (const stop of [
        ...projectWatches.values(),
        ...outputWatches.values(),
      ])
        stop();
      projectWatches.clear();
      outputWatches.clear();
    },
  };
};
