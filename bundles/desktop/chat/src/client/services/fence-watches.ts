// `chat.views/v1.watchFences` (openui.md D1): a Thread's fences of one tag for
// a surface outside the conversation. One watch per Thread, counted and shared
// by every subscription of it, folds the Thread into a private `ThreadChats`
// value with the store's own domain functions over a `ThreadWatch` of its own,
// so the conversation store's Threads, recency and bound never change because
// of it, and its eviction of a Thread ends no watch.

import {
  type Disposable,
  DoricConnectionV1,
  type StreamListener,
  toStreamObserver,
} from 'bundle/contracts';
import { RuntimeThreadsV1 } from 'runtime/contracts';

import type { ChatFence } from '../../contracts/index.js';
import {
  createThreadWatch,
  type ThreadStream,
  type ThreadWatch,
} from '../api/thread-watch.js';
import { type ChatThreadsApi, threadsApi } from '../api/threads-api.js';
import { threadFences } from '../domain/fences.js';
import {
  applyThreadEvents,
  applyThreadUpdate,
  emptyThreadChats,
  openThread,
  type ThreadChats,
} from '../domain/thread-chats.js';
import type { ThreadEvent, ThreadUpdate } from '../domain/workspace.js';
import { STREAM_FLUSH_MS } from '../stores/thread-chats.js';
import { chatServices } from './chat-services.js';
import type { FenceRegistry } from './fence-registry.js';

export interface FenceWatchesDependencies {
  readonly threads: Pick<ChatThreadsApi, 'get' | 'history'>;
  readonly watch: ThreadWatch;
}

export interface FenceWatchInput {
  readonly projectId: string;
  readonly threadId: string;
  readonly tag: string;
}

export interface FenceWatches {
  watch(
    input: FenceWatchInput,
    listener: StreamListener<readonly ChatFence[]>,
  ): Disposable;
}

interface Subscriber {
  readonly input: FenceWatchInput;
  readonly next: (fences: readonly ChatFence[]) => void;
  last: readonly ChatFence[] | undefined;
}

interface Entry {
  readonly threadId: string;
  readonly subscribers: Set<Subscriber>;
  /** The Thread's private chats; `undefined` until its first fold. */
  chats: ThreadChats | undefined;
  /** The Thread's `projectId`, once its record is read. */
  projectId: string | undefined;
  release: (() => void) | undefined;
  queued: ThreadEvent[];
  flush: ReturnType<typeof setTimeout> | undefined;
}

/** The fences' own watch, over the chat's activation services. */
const windowDependencies = (): FenceWatchesDependencies => ({
  threads: threadsApi,
  watch: createThreadWatch({
    stream: () =>
      chatServices().use(RuntimeThreadsV1) as unknown as ThreadStream,
    connection: () => chatServices().use(DoricConnectionV1),
  }),
});

/** Whether two lists hold the same fences, by key, state and body. */
const sameFences = (
  one: readonly ChatFence[],
  other: readonly ChatFence[],
): boolean =>
  one.length === other.length &&
  one.every((fence, at) => {
    const that = other[at];
    return (
      that !== undefined &&
      that.key === fence.key &&
      that.state === fence.state &&
      that.body === fence.body
    );
  });

export const createFenceWatches = (
  registry: Pick<FenceRegistry, 'tags' | 'subscribe'>,
  dependencies?: FenceWatchesDependencies,
): FenceWatches => {
  const entries = new Map<string, Entry>();
  let resolved: FenceWatchesDependencies | undefined = dependencies;
  const using = (): FenceWatchesDependencies => {
    resolved ??= windowDependencies();
    return resolved;
  };

  const tell = (subscriber: Subscriber, fences: readonly ChatFence[]): void => {
    if (subscriber.last !== undefined && sameFences(subscriber.last, fences))
      return;
    subscriber.last = fences;
    try {
      subscriber.next(fences);
    } catch (error) {
      console.error('Doric: a fence watch listener failed:', error);
    }
  };

  /** Tells each subscriber its tag's list, when it changed. */
  const publish = (entry: Entry): void => {
    const turns = entry.chats?.chats.get(entry.threadId)?.projection.turns;
    if (turns === undefined) return;
    const tags = registry.tags();
    for (const subscriber of entry.subscribers) {
      const { tag, projectId, threadId } = subscriber.input;
      tell(
        subscriber,
        tags.has(tag)
          ? threadFences(turns, new Set([tag]), { projectId, threadId })
          : [],
      );
    }
  };

  const end = (entry: Entry): void => {
    if (entries.get(entry.threadId) === entry) entries.delete(entry.threadId);
    if (entry.flush !== undefined) clearTimeout(entry.flush);
    entry.flush = undefined;
    entry.queued = [];
    entry.release?.();
    entry.release = undefined;
    entry.subscribers.clear();
  };

  const drain = (entry: Entry): void => {
    entry.flush = undefined;
    const batch = entry.queued;
    entry.queued = [];
    if (entry.chats === undefined || batch.length === 0) return;
    entry.chats = applyThreadEvents(entry.chats, entry.threadId, batch).chats;
    publish(entry);
  };

  const receive = (entry: Entry, update: ThreadUpdate): void => {
    if (entries.get(entry.threadId) !== entry || entry.chats === undefined)
      return;
    if (update.kind === 'event') {
      entry.queued.push(update.event);
      entry.flush ??= setTimeout(() => drain(entry), STREAM_FLUSH_MS);
      return;
    }
    if (update.kind === 'deleted') {
      for (const subscriber of entry.subscribers) tell(subscriber, []);
      end(entry);
      return;
    }
    // An `error` keeps the last list while the watch subscribes again.
    if (update.kind === 'error') return;
    entry.chats = applyThreadUpdate(entry.chats, entry.threadId, update).chats;
    publish(entry);
  };

  /** Reads the Thread and its cached history, then folds and watches it. */
  const start = (entry: Entry): void => {
    const { threads, watch } = using();
    void Promise.all([
      threads.get(entry.threadId).catch(() => undefined),
      threads.history(entry.threadId).catch(() => null),
    ]).then(([thread, history]) => {
      if (entries.get(entry.threadId) !== entry) return;
      if (thread === undefined) {
        for (const subscriber of entry.subscribers) tell(subscriber, []);
        end(entry);
        return;
      }
      entry.projectId = thread.projectId;
      // A subscription of another Project gets `[]` once and holds nothing.
      for (const subscriber of [...entry.subscribers]) {
        if (subscriber.input.projectId === thread.projectId) continue;
        tell(subscriber, []);
        entry.subscribers.delete(subscriber);
      }
      if (entry.subscribers.size === 0) {
        end(entry);
        return;
      }
      const opened = openThread(emptyThreadChats, thread, history);
      entry.chats = opened.chats;
      for (const effect of opened.effects) {
        if (effect.kind !== 'watch') continue;
        entry.release = watch.watch(
          entry.threadId,
          effect.afterSequence,
          (update) => receive(entry, update),
        );
      }
      publish(entry);
    });
  };

  // A registration that starts or ends changes every list of its tag.
  registry.subscribe(() => {
    for (const entry of entries.values()) publish(entry);
  });

  return {
    watch: (input, listener) => {
      const observer = toStreamObserver(listener);
      const subscriber: Subscriber = {
        input,
        next: (fences) => observer.next(fences),
        last: undefined,
      };
      let entry = entries.get(input.threadId);
      if (entry === undefined) {
        entry = {
          threadId: input.threadId,
          subscribers: new Set(),
          chats: undefined,
          projectId: undefined,
          release: undefined,
          queued: [],
          flush: undefined,
        };
        entries.set(input.threadId, entry);
        entry.subscribers.add(subscriber);
        start(entry);
      } else if (
        entry.projectId !== undefined &&
        entry.projectId !== input.projectId
      ) {
        tell(subscriber, []);
        return { dispose: () => {} };
      } else {
        entry.subscribers.add(subscriber);
        publish(entry);
      }

      const held = entry;
      let disposed = false;
      return {
        dispose: () => {
          if (disposed) return;
          disposed = true;
          if (!held.subscribers.delete(subscriber)) return;
          if (held.subscribers.size === 0) end(held);
        },
      };
    },
  };
};
