import {
  ContractError,
  type Disposable,
  type StreamListener,
  type StreamObserver,
  toStreamObserver,
} from 'bundle/contracts';

import type {
  Project,
  Terminal,
  Thread,
  ThreadEvent,
} from '../../contracts/model.js';
import type { RuntimeNotice } from '../../contracts/runtime.js';
import {
  type ProjectWatchItem,
  replayFailedMessage,
  type TerminalWatchItem,
  type ThreadWatchItem,
} from '../../contracts/watches.js';
import type { Notices } from '../domain/notices.js';

/*
 * The remote watches (stage 9 R-STREAM): the algorithm of the transport's
 * Socket.IO namespaces (bundles/transport/src/host/sockets/workspace.ts) over
 * a stream observer instead of a socket. Each watch subscribes to the runtime
 * notices first, then reads the durable snapshot; what arrives in between is
 * buffered, Thread events are deduplicated against the replay and delivered
 * gap-free, and terminal output is never buffered.
 */

/** The durable reads a snapshot needs, the same the transport socket makes. */
export interface WatchReads {
  /** The stored Thread record, without the storage-pause overlay. */
  thread(threadId: string): Promise<Thread | undefined>;
  eventsAfter(
    threadId: string,
    afterSequence: number,
  ): Promise<readonly ThreadEvent[]>;
  project(projectId: string): Promise<Project | undefined>;
  projectThreads(projectId: string): Promise<readonly Thread[]>;
  terminals(projectId: string): Promise<readonly Terminal[]>;
}

export interface Watches {
  thread(
    input: { readonly threadId: string; readonly afterSequence: number },
    listener: StreamListener<ThreadWatchItem>,
  ): Disposable;
  project(
    input: { readonly projectId: string },
    listener: StreamListener<ProjectWatchItem>,
  ): Disposable;
  terminals(
    projectId: string,
    listener: StreamListener<TerminalWatchItem>,
  ): Disposable;
}

/**
 * One open watch: delivery stops for good at dispose or at the end. A remote
 * listener answers a promise; its rejection (the window went away) is not
 * this watch's failure, so it is dropped.
 */
const openStream = <T>(listener: StreamListener<T>) => {
  const observer: StreamObserver<T> = toStreamObserver(listener);
  let open = true;
  const settle = (result: unknown) => {
    if (result instanceof Promise) result.catch(() => undefined);
  };

  return {
    get open() {
      return open;
    },
    next(item: T) {
      if (!open) return;
      try {
        settle(observer.next(item) as unknown);
      } catch {
        // A listener that throws never reaches back into the runtime.
      }
    },
    end(error?: ContractError) {
      if (!open) return;
      open = false;
      try {
        settle(observer.end?.(error) as unknown);
      } catch {
        // As above.
      }
    },
    close() {
      open = false;
    },
  };
};

type Stream<T> = ReturnType<typeof openStream<T>>;

/**
 * Buffers items until the snapshot was delivered (`ready`), then passes them
 * straight through, in arrival order.
 */
const gate = <T>(stream: Stream<T>) => {
  let ready = false;
  const pending: T[] = [];

  return {
    get ready() {
      return ready;
    },
    push(item: T) {
      if (ready) stream.next(item);
      else pending.push(item);
    },
    release() {
      ready = true;
      for (const item of pending.splice(0)) stream.next(item);
    },
    clear() {
      pending.length = 0;
    },
  };
};

const replayFailed = () =>
  new ContractError('replay_failed', replayFailedMessage);

export const createWatches = ({
  notices,
  reads,
}: {
  readonly notices: Pick<Notices, 'watch'>;
  readonly reads: WatchReads;
}): Watches => {
  /** Subscribes `onNotice` for the life of `stream`; returns its Disposable. */
  const follow = <T>(
    stream: Stream<T>,
    onNotice: (notice: RuntimeNotice) => void,
    cleanup: () => void,
  ) => {
    const watching = notices.watch((notice) => {
      if (stream.open) onNotice(notice);
    });
    let disposed = false;
    const dispose = () => {
      if (disposed) return;
      disposed = true;
      watching.dispose();
      cleanup();
    };

    return {
      dispose,
      /** A failed snapshot read: end the stream with the sanitized error. */
      fail: () => {
        if (!stream.open) return;
        dispose();
        stream.end(replayFailed());
      },
      disposable: {
        dispose: () => {
          stream.close();
          dispose();
        },
      } satisfies Disposable,
    };
  };

  return {
    thread: ({ threadId, afterSequence }, listener) => {
      const stream = openStream(listener);
      const notified = gate(stream);
      const events = new Map<number, ThreadEvent>();
      let lastSequence = afterSequence;
      /** A delayed publication must not lose an earlier, persisted event. */
      const flushEvents = () => {
        for (const sequence of events.keys()) {
          if (sequence <= lastSequence) events.delete(sequence);
        }
        for (;;) {
          const event = events.get(lastSequence + 1);
          if (event === undefined) return;
          stream.next({ kind: 'event', event });
          lastSequence = event.sequence;
          events.delete(event.sequence);
        }
      };
      const watch = follow(
        stream,
        (notice) => {
          switch (notice.kind) {
            case 'event':
              if (notice.value.threadId !== threadId) return;
              if (notice.value.sequence <= lastSequence) return;
              events.set(notice.value.sequence, notice.value);
              if (notified.ready) flushEvents();
              return;
            case 'threadUpdated':
              if (notice.value.id === threadId)
                notified.push({ kind: 'updated', thread: notice.value });
              return;
            case 'threadDeleted':
              if (notice.threadId === threadId)
                notified.push({
                  kind: 'deleted',
                  projectId: notice.projectId,
                  threadId,
                });
              return;
            default:
              return;
          }
        },
        () => {
          events.clear();
          notified.clear();
        },
      );

      void (async () => {
        try {
          const [record, history] = await Promise.all([
            reads.thread(threadId),
            reads.eventsAfter(threadId, afterSequence),
          ]);
          const project =
            record === undefined
              ? undefined
              : await reads.project(record.projectId);
          if (!stream.open) return;
          const replayed = history
            .filter((event) => event.sequence > afterSequence)
            .sort((a, b) => a.sequence - b.sequence);
          stream.next({
            kind: 'snapshot',
            threadId,
            projectId: record?.projectId ?? null,
            project: project ?? null,
            thread: record ?? null,
            events: replayed,
          });
          lastSequence = replayed.at(-1)?.sequence ?? afterSequence;
          // Events first, then the lifecycle notices, as the socket flushes.
          flushEvents();
          notified.release();
        } catch {
          watch.fail();
        }
      })();

      return watch.disposable;
    },

    project: ({ projectId }, listener) => {
      const stream = openStream(listener);
      const notified = gate(stream);
      const watch = follow(
        stream,
        (notice) => {
          switch (notice.kind) {
            case 'threadUpdated':
              if (notice.value.projectId === projectId)
                notified.push({ kind: 'thread-updated', thread: notice.value });
              return;
            case 'threadDeleted':
              if (notice.projectId === projectId)
                notified.push({
                  kind: 'thread-deleted',
                  projectId,
                  threadId: notice.threadId,
                });
              return;
            case 'projectUpdated':
              if (notice.value.id === projectId)
                notified.push({
                  kind: 'project-updated',
                  project: notice.value,
                });
              return;
            case 'projectDeleted':
              if (notice.projectId === projectId)
                notified.push({ kind: 'project-deleted', projectId });
              return;
            default:
              return;
          }
        },
        () => notified.clear(),
      );

      void (async () => {
        try {
          const [record, threads] = await Promise.all([
            reads.project(projectId),
            reads.projectThreads(projectId),
          ]);
          // Read once after the tree, where the socket snapshot reads it.
          const terminals = await reads.terminals(projectId);
          if (!stream.open) return;
          stream.next({
            kind: 'snapshot',
            projectId,
            project: record ?? null,
            threads,
            terminals,
          });
          notified.release();
        } catch {
          watch.fail();
        }
      })();

      return watch.disposable;
    },

    terminals: (projectId, listener) => {
      const stream = openStream(listener);
      const notified = gate(stream);
      const watch = follow(
        stream,
        (notice) => {
          switch (notice.kind) {
            case 'terminalUpdated':
              if (notice.value.projectId === projectId)
                notified.push({ kind: 'updated', terminal: notice.value });
              return;
            case 'terminalRemoved':
              if (notice.projectId === projectId)
                notified.push({
                  kind: 'removed',
                  projectId,
                  threadId: notice.threadId,
                  terminalId: notice.terminalId,
                });
              return;
            case 'terminalOutput':
              // A reconnect reads the bounded terminal snapshot instead of a
              // second, unbounded copy of stdout buffered here.
              if (notice.value.projectId === projectId && notified.ready)
                stream.next({ kind: 'output', output: notice.value });
              return;
            default:
              return;
          }
        },
        () => notified.clear(),
      );

      void (async () => {
        try {
          const terminals = await reads.terminals(projectId);
          if (!stream.open) return;
          stream.next({ kind: 'snapshot', projectId, terminals });
          notified.release();
        } catch {
          watch.fail();
        }
      })();

      return watch.disposable;
    },
  };
};
