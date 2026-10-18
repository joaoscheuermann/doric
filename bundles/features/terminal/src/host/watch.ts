import {
  type Disposable,
  type StreamListener,
  type StreamObserver,
  toStreamObserver,
} from 'bundle/contracts';

import type { TerminalWatchItem } from '../contracts/index.js';
import type { TerminalNotice, TerminalRegistry } from './registry.js';

/*
 * A Project's terminal stream: the algorithm of the runtime's
 * `runtime.terminals/v1.watchProject` (and of the transport's `/projects`
 * namespace before it). It follows the registry's notices first, then sends
 * the snapshot; updates and removals that arrive in between are delivered
 * after it, and output is never buffered: a reconnect reads the bounded
 * terminal snapshot instead of a second, unbounded copy of stdout.
 */

export interface TerminalNotices {
  watch(listener: (notice: TerminalNotice) => void): Disposable;
}

/** A local emitter of the registry's notices. */
export const createNotices = (): TerminalNotices & {
  readonly notify: (notice: TerminalNotice) => void;
} => {
  const listeners = new Set<(notice: TerminalNotice) => void>();

  return {
    notify: (notice) => {
      for (const listener of [...listeners]) {
        try {
          listener(notice);
        } catch {
          // One failing watcher never reaches the registry or another one.
        }
      }
    },
    watch: (listener) => {
      const entry = (notice: TerminalNotice) => listener(notice);
      listeners.add(entry);
      return { dispose: () => listeners.delete(entry) };
    },
  };
};

/** Delivery stops for good at dispose; a remote listener's rejection is dropped. */
const openStream = <T>(listener: StreamListener<T>) => {
  const observer: StreamObserver<T> = toStreamObserver(listener);
  let open = true;

  return {
    get open() {
      return open;
    },
    next(item: T) {
      if (!open) return;
      try {
        const result = observer.next(item) as unknown;
        if (result instanceof Promise) result.catch(() => undefined);
      } catch {
        // A listener that throws never reaches back into the registry.
      }
    },
    close() {
      open = false;
    },
  };
};

export const watchProject = (
  notices: TerminalNotices,
  registry: Pick<TerminalRegistry, 'list'>,
  projectId: string,
  listener: StreamListener<TerminalWatchItem>,
): Disposable => {
  const stream = openStream(listener);
  let ready = false;
  const pending: TerminalWatchItem[] = [];
  const push = (item: TerminalWatchItem) => {
    if (ready) stream.next(item);
    else pending.push(item);
  };
  const watching = notices.watch((notice) => {
    if (!stream.open) return;
    switch (notice.kind) {
      case 'updated':
        if (notice.terminal.projectId === projectId)
          push({ kind: 'updated', terminal: notice.terminal });
        return;
      case 'removed':
        if (notice.projectId === projectId)
          push({
            kind: 'removed',
            projectId,
            threadId: notice.threadId,
            terminalId: notice.terminalId,
          });
        return;
      case 'output':
        if (notice.output.projectId === projectId && ready)
          stream.next({ kind: 'output', output: notice.output });
        return;
    }
  });

  void Promise.resolve().then(() => {
    if (!stream.open) return;
    stream.next({
      kind: 'snapshot',
      projectId,
      terminals: [...registry.list(projectId)],
    });
    ready = true;
    for (const item of pending.splice(0)) stream.next(item);
  });

  return {
    dispose: () => {
      stream.close();
      watching.dispose();
      pending.length = 0;
    },
  };
};
