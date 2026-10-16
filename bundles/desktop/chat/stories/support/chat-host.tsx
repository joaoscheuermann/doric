// A stand-in for the host the chat's views and elements read, so their stories
// draw a real conversation and composer without a running Doric. The chat
// reaches the host through its activation services (`initChat`) and the
// sidebar tree (`setWorkspace`); this world answers both from the fixtures:
// `runtime.threads/v1` replays each Thread's log and queue, `chat.composer/v1`
// holds each Thread's draft and stack, and the rest (`ui/v1`, `navigation/v1`,
// `commands/v1`, `doric.connection/v1`) answer the way a quiet window does.
// A send is accepted and answered once, a moment later; nothing else moves on
// its own.

import { QueryClientProvider } from '@tanstack/react-query';
import type { Services } from 'bundle/contracts';
import { Toaster } from 'desktop/ui/sonner';
import { TooltipProvider } from 'desktop/ui/tooltip';
import type { ReactNode } from 'react';

import type { ThreadQueue } from '../../src/client/domain/queue.js';
import type { Thread, ThreadEvent } from '../../src/client/domain/workspace.js';
import { chatQueryClient } from '../../src/client/queries/client.js';
import { queryKeys } from '../../src/client/queries/keys.js';
import {
  initChat,
  setWorkspace,
} from '../../src/client/services/chat-services.js';
import type {
  ComposerItem,
  ComposerWatchItem,
} from '../../src/contracts/index.js';
import {
  emptyQueue,
  project,
  projectId,
  threadDrafts,
  threadEvents,
  threadIds,
  threadQueues,
  threads,
} from './fixtures.js';

type Listener<T> = ((item: T) => void) | { readonly next: (item: T) => void };

const emit = <T,>(listener: Listener<T>, item: T): void => {
  if (typeof listener === 'function') listener(item);
  else listener.next(item);
};

const disposable = (dispose: () => void = () => undefined) => ({ dispose });

/** A host call's answer: what `run` returns, or its throw as a rejection. */
const answer = <T,>(run: () => T): Promise<T> =>
  new Promise((resolve) => resolve(run()));

/** The Threads the stories open, by id. */
const records = new Map<string, Thread>(
  Object.values(threads).map((thread) => [thread.id, thread]),
);
const logs = new Map<string, ThreadEvent[]>(
  Object.entries(threadEvents).map(([id, events]) => [id, [...events]]),
);
const queues = new Map<string, ThreadQueue>(Object.entries(threadQueues));
const drafts = new Map<
  string,
  { text: string; items: ComposerItem[]; next: number }
>(
  Object.entries(threadDrafts).map(([id, draft]) => [
    id,
    { text: draft.text, items: [...draft.items], next: 100 },
  ]),
);
const watchers = new Map<string, Set<Listener<unknown>>>();
const composerWatchers = new Map<string, Set<Listener<ComposerWatchItem>>>();

/** The queue that cannot be read: its resume is disabled by the error. */
const failingQueues = new Set<string>([threadIds.composerQueueError]);

const draftOf = (threadId: string) => {
  let draft = drafts.get(threadId);
  if (draft === undefined) {
    draft = { text: '', items: [], next: 100 };
    drafts.set(threadId, draft);
  }
  return draft;
};

const composerChanged = (item: ComposerWatchItem): void => {
  for (const listener of composerWatchers.get(item.threadId) ?? [])
    emit(listener, item);
};

/** Appends events to a Thread's log and tells every watch of it. */
const append = (
  threadId: string,
  promptId: string,
  events: readonly Readonly<Record<string, unknown> & { type: string }>[],
): void => {
  const log = logs.get(threadId) ?? [];
  logs.set(threadId, log);
  for (const event of events) {
    const item: ThreadEvent = {
      projectId,
      threadId,
      promptId,
      sequence: (log.at(-1)?.sequence ?? 0) + 1,
      type: event.type,
      event,
      createdAt: new Date().toISOString(),
    };
    log.push(item);
    for (const listener of watchers.get(threadId) ?? [])
      emit(listener, { kind: 'event', event: item });
  }
};

/** The one answer a send gets from the story host. */
const reply =
  'This preview has no agent behind it, so this is the only answer it gives.';

const runtimeThreads = {
  thread: async (id: string) => records.get(id),
  queue: (id: string) =>
    answer(() => {
      if (failingQueues.has(id))
        throw new Error('The queue could not be read.');
      return queues.get(id) ?? emptyQueue;
    }),
  watchThread: (
    input: { readonly threadId: string },
    listener: Listener<unknown>,
  ) => {
    const set = watchers.get(input.threadId) ?? new Set();
    watchers.set(input.threadId, set);
    set.add(listener);
    queueMicrotask(() => {
      if (!set.has(listener)) return;
      emit(listener, {
        kind: 'snapshot',
        threadId: input.threadId,
        projectId,
        project,
        thread: records.get(input.threadId) ?? null,
        events: logs.get(input.threadId) ?? [],
      });
    });
    return disposable(() => set.delete(listener));
  },
  prompt: (input: { readonly id: string; readonly prompt: string }) =>
    answer(() => {
      const promptId = crypto.randomUUID();
      append(input.id, promptId, [
        {
          type: 'prompt.accepted',
          text: input.prompt,
          source: { kind: 'user' },
        },
      ]);
      // One answer, once: the story's host has nothing else to say.
      setTimeout(() => {
        append(input.id, promptId, [
          { type: 'text.delta', delta: reply },
          {
            type: 'prompt.finished',
            status: 'completed',
            text: reply,
            source: { kind: 'user' },
          },
        ]);
      }, 600);
      return { status: 'accepted', promptId };
    }),
  rewind: async () => ({ status: 'accepted', promptId: crypto.randomUUID() }),
  resume: async (input: { readonly id: string }) => ({
    status: 'resumed',
    thread: records.get(input.id),
  }),
  pause: async () => 'interrupted',
  queuedPrompt: (input: { readonly id: string; readonly promptId: string }) =>
    answer(() => {
      const item = queues
        .get(input.id)
        ?.items.find((queued) => queued.promptId === input.promptId);
      return item === undefined
        ? undefined
        : {
            promptId: item.promptId,
            text: item.preview,
            revision: item.revision ?? 1,
            editable: item.editable ?? true,
          };
    }),
  editQueued: async (input: {
    readonly promptId: string;
    readonly text: string;
    readonly revision: number;
  }) => ({
    status: 'updated',
    prompt: {
      promptId: input.promptId,
      text: input.text,
      revision: input.revision + 1,
      editable: true,
    },
  }),
  removeQueued: async () => 'removed',
  resumeQueue: async (id: string) => ({
    status: 'resumed',
    thread: records.get(id),
  }),
};

const chatComposer = {
  read: (input: { readonly threadId: string }) =>
    answer(() => {
      const draft = draftOf(input.threadId);
      return { threadId: input.threadId, text: draft.text, items: draft.items };
    }),
  watch: (threadId: string, listener: Listener<ComposerWatchItem>) => {
    const set = composerWatchers.get(threadId) ?? new Set();
    composerWatchers.set(threadId, set);
    set.add(listener);
    const draft = draftOf(threadId);
    emit(listener, {
      kind: 'snapshot',
      threadId,
      text: draft.text,
      items: [...draft.items],
    });
    return disposable(() => set.delete(listener));
  },
  setText: (input: { readonly threadId: string; readonly text: string }) =>
    answer(() => {
      draftOf(input.threadId).text = input.text;
      composerChanged({ kind: 'text', ...input });
    }),
  addItem: (input: {
    readonly threadId: string;
    readonly kind: string;
    readonly elementTag: string;
    readonly data?: unknown;
    readonly note?: string;
  }) =>
    answer(() => {
      const draft = draftOf(input.threadId);
      draft.next += 1;
      const item: ComposerItem = {
        id: `comment-story-${draft.next}`,
        kind: input.kind,
        elementTag: input.elementTag,
        data: input.data,
        note: input.note ?? '',
      };
      draft.items.push(item);
      composerChanged({ kind: 'added', threadId: input.threadId, item });
      return item;
    }),
  updateNote: (input: {
    readonly threadId: string;
    readonly id: string;
    readonly note: string;
  }) =>
    answer(() => {
      const draft = draftOf(input.threadId);
      const index = draft.items.findIndex((item) => item.id === input.id);
      const item = draft.items[index];
      if (item === undefined) return;
      const next = { ...item, note: input.note };
      draft.items[index] = next;
      composerChanged({
        kind: 'updated',
        threadId: input.threadId,
        item: next,
      });
    }),
  removeItem: (input: { readonly threadId: string; readonly id: string }) =>
    answer(() => {
      const draft = draftOf(input.threadId);
      draft.items = draft.items.filter((item) => item.id !== input.id);
      composerChanged({ kind: 'removed', ...input });
    }),
  flush: (input: { readonly threadId: string }) =>
    answer(() => {
      const draft = draftOf(input.threadId);
      const flushed = draft.items.map((item) => ({ item, writes: [] }));
      for (const { item } of flushed)
        composerChanged({
          kind: 'removed',
          threadId: input.threadId,
          id: item.id,
        });
      draft.items = [];
      return flushed;
    }),
  registerFlush: () => disposable(),
};

const ui = {
  define: () => disposable(),
  create: (tag: string, props?: Readonly<Record<string, unknown>>) =>
    Object.assign(document.createElement(tag), props ?? {}),
  dispose: (element: object) => {
    if (element instanceof Element) element.remove();
  },
};

/** The commands a card's intent ran, newest last, for a story to show. */
export const executedCommands: { command: string; input?: unknown }[] = [];

const implementations: Readonly<Record<string, unknown>> = {
  'runtime.threads/v1': runtimeThreads,
  'chat.composer/v1': chatComposer,
  'comments/v1': { add: async () => undefined },
  'doric.connection/v1': {
    status: () => 'connected',
    subscribe: () => disposable(),
  },
  'ui/v1': ui,
  'navigation/v1': {
    register: () => disposable(),
    navigate: (path: string) => console.info('Doric story: navigate', path),
  },
  'commands/v1': {
    register: () => disposable(),
    execute: (command: string, input?: unknown) =>
      answer(() => {
        executedCommands.push({ command, input });
      }),
  },
};

/**
 * Services over `implementations`, with `overrides` (by contract id) taking
 * precedence; a contract nobody answers is unavailable, as in a window
 * without its provider.
 */
export const storyServices = (
  overrides: Readonly<Record<string, unknown>> = {},
): Services => {
  const find = (contract: { readonly id: string }): unknown => {
    const found = overrides[contract.id] ?? implementations[contract.id];
    if (found === undefined)
      throw new Error(`The story host has no "${contract.id}".`);
    return found;
  };
  return {
    provide: () => disposable(),
    use: find,
    whenAvailable: (contract: { readonly id: string }, callback) => {
      const found = overrides[contract.id] ?? implementations[contract.id];
      if (found === undefined) return disposable();
      const cleanup = callback(found as never, {
        bundleId: 'story',
        version: '1.0.0',
      });
      return disposable(() => {
        if (typeof cleanup === 'function') void cleanup();
      });
    },
  } as Services;
};

// The sidebar tree --------------------------------------------------------

let selected: string | undefined;
const workspaceListeners = new Set<() => void>();

const workspace = {
  thread: (threadId: string) => records.get(threadId),
  selectedThread: () =>
    selected === undefined ? undefined : records.get(selected),
  subscribe: (listener: () => void) => {
    workspaceListeners.add(listener);
    return disposable(() => workspaceListeners.delete(listener));
  },
};

/** Selects a Thread in the tree, as the sidebar does; `undefined` for none. */
export const selectThread = (threadId: string | undefined): void => {
  if (selected === threadId) return;
  selected = threadId;
  queueMicrotask(() => {
    for (const listener of [...workspaceListeners]) listener();
  });
};

let installed = false;

/**
 * Activates the chat over the story host: the activation services, the tree,
 * and the queue every Thread holds already in the window's query client. Once
 * per window; every later call is a no-op.
 */
export const installChatHost = (): Services => {
  const services = storyServices();
  if (installed) return services;
  installed = true;
  initChat(services);
  setWorkspace(workspace);
  for (const thread of records.values())
    chatQueryClient.setQueryData(
      queryKeys.threadQueue(thread.id),
      queues.get(thread.id) ?? emptyQueue,
    );
  return services;
};

/**
 * What a chat root wraps its content in (`elements/chat-elements.tsx`): the
 * window's one chat query client and a tooltip provider, over the story host,
 * with the window's single toaster beside it.
 */
export function ChatHost({
  children,
  selectedThread,
}: {
  readonly children?: ReactNode;
  /** The Thread the sidebar selects for `<chat-composer>`. */
  readonly selectedThread?: string;
}) {
  installChatHost();
  selectThread(selectedThread);
  return (
    <QueryClientProvider client={chatQueryClient}>
      <TooltipProvider>
        {children}
        <Toaster />
      </TooltipProvider>
    </QueryClientProvider>
  );
}
