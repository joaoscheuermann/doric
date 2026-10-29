import { createStore } from 'zustand/vanilla';

import type { ThreadUpdateInput, TurnComment } from '../../contracts/index.js';
import { composerFeed } from '../api/composer.js';
import { type HistoryFeed, historyFeed } from '../api/history.js';
import { type ThreadWatch, threadWatch } from '../api/thread-watch.js';
import {
  type ChatThreadsApi,
  type PromptReceipt,
  threadsApi,
} from '../api/threads-api.js';
import { messageFrom } from '../domain/errors.js';
import { promptMessage, sentComments } from '../domain/prompt-envelope.js';
import { queueChanged } from '../domain/queue.js';
import {
  applyThreadEvents,
  applyThreadUpdate,
  clearPending,
  emptyThreadChats,
  openThread,
  sendComments,
  settleSentComments,
  showThread,
  startPending,
  type ThreadChatEffect,
  type ThreadChats,
  withSendError,
  withSending,
} from '../domain/thread-chats.js';
import type { Thread, ThreadEvent, ThreadUpdate } from '../domain/workspace.js';
import { chatHooks } from '../services/chat-hooks.js';
import { composerStackStore } from './composer-stack.js';

const queueListeners = new Map<string, Set<() => void>>();
/** Observe queue invalidations through the existing Thread watch. */
export const subscribeThreadQueue = (
  id: string,
  listener: () => void,
): (() => void) => {
  const listeners = queueListeners.get(id) ?? new Set<() => void>();
  listeners.add(listener);
  queueListeners.set(id, listeners);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) queueListeners.delete(id);
  };
};

/**
 * How long a stream's events wait before they reach the projection. A live run
 * writes its log thousands of events at a time, and every event that reached the
 * projection would re-read the whole of it — the cost a whole run pays, not one
 * event. A flush carries a burst instead, and the first event of one lands at
 * once, so a turn the reader is waiting for is not the one that waits. The wait
 * is held per Thread, because each keeps its own stream.
 */
const STREAM_FLUSH_MS = 100;

/**
 * The surface's copy of every opened Thread's chat. It lives here, not in a
 * component or a hook, so that switching Threads — which remounts the surface —
 * keeps the state of the one left behind and its watch stays open: the reader
 * sees a running conversation's live projection the moment it is shown again,
 * with nothing replayed.
 *
 * Which Threads it holds and which watches to keep are the rules in
 * `@/domain/thread-chats`; this store only owns the watches and the message
 * channel, applies those rules, and hands each Thread's slice to React.
 */
export type ThreadChatsState = {
  readonly chats: ThreadChats;
  /** Opens (or shows) a Thread, subscribing where its cached history ends. */
  readonly open: (thread: Thread) => void;
  /**
   * Sends a prompt from a Thread, recording it as pending until accepted. The
   * Project names where the stack flushes when this window has not opened the
   * Thread (a send from outside the conversation).
   */
  readonly prompt: (
    id: string,
    text: string,
    options?: { readonly projectId?: string },
  ) => Promise<boolean>;
  /**
   * Sends input into the running prompt `promptId` through `threads.steer`,
   * the same way `prompt` sends: pending until accepted, then the stack
   * flushes into it. `interrupt` also aborts the prompt's current step.
   */
  readonly steer: (
    id: string,
    text: string,
    options: { readonly promptId: string; readonly interrupt?: boolean },
  ) => Promise<boolean>;
  /** Replaces a past prompt of a Thread through `threads.rewind`. */
  readonly rewind: (
    id: string,
    promptId: string,
    text: string,
  ) => Promise<boolean>;
  /**
   * Takes up a prompt an interruption left unfinished through `threads.resume`,
   * drawing the Thread the host answers with so the surface leaves the pause
   * behind at once instead of waiting for the stream.
   */
  readonly resume: (id: string, promptId: string) => Promise<boolean>;
  /**
   * Sends the Thread's last prompt again through `threads.retry`, the third
   * lever on an agent Thread: the host reads the text from the log.
   */
  readonly retry: (id: string) => Promise<boolean>;
  /**
   * Releases every watch and forgets every Thread: the chat part is
   * deactivating, so nothing it opened may outlive it.
   */
  readonly closeAll: () => void;
};

/** What the store talks to; the defaults are the chat's host adapters. */
export interface ThreadChatsDependencies {
  readonly watch: ThreadWatch;
  readonly threads: Pick<
    ChatThreadsApi,
    'history' | 'prompt' | 'steer' | 'rewind' | 'resume' | 'retry'
  >;
  readonly history: HistoryFeed;
  /**
   * The send flush: runs once the host accepted a prompt, flushing the
   * composer's comment stack — the drafts above the prompt — into durable
   * comment events, and only then emptying it. `undefined` when the composer's
   * service is unreachable, which leaves the drafts drafted. Answers the ids
   * of the comments it wrote.
   */
  readonly flush?: (input: {
    readonly threadId: string;
    readonly projectId: string;
    readonly promptId: string;
  }) => Promise<readonly string[]>;
  /**
   * The comments a prompt about to be sent carries, as the log will hold them
   * (`sentComments`), read from the Thread's stack; none by default.
   */
  readonly comments?: (id: string, text: string) => readonly TurnComment[];
  /**
   * R-9.6: told every live event of a held Thread as it is received, and
   * every `updated` record (`chat.hooks/v1.onThreadUpdateHook`).
   */
  readonly observe?: ObserveUpdate;
}

/** One live update as `onThreadUpdateHook` reports it. */
export type ObserveUpdate = (input: {
  readonly projectId: string;
  readonly threadId: string;
  readonly threadName: string;
  readonly update:
    | { readonly kind: 'event'; readonly event: ThreadEvent }
    | { readonly kind: 'updated'; readonly thread: Thread };
}) => void;

export const createThreadChatsStore = (
  dependencies: ThreadChatsDependencies,
) => {
  /** The live watches, one per open Thread, released by id. */
  const watches = new Map<string, () => void>();
  /** Threads whose first history read is still in flight. */
  const opening = new Set<string>();
  /** Each Thread's events held until its next flush. */
  const queued = new Map<string, ThreadEvent[]>();
  /** Each Thread's pending flush. */
  const flushes = new Map<string, ReturnType<typeof setTimeout>>();
  /** When each Thread last flushed, so a burst's first event lands at once. */
  const flushedAt = new Map<string, number>();
  /** Bumped by `closeAll`, so a history read in flight lands nowhere. */
  let epoch = 0;

  return createStore<ThreadChatsState>()((set, get) => {
    const setChats = (chats: ThreadChats): void => set({ chats });

    /** Runs the effects a change asked for: opening or releasing one watch each. */
    const applyEffects = (effects: readonly ThreadChatEffect[]): void => {
      for (const effect of effects) {
        if (effect.kind === 'watch') {
          // A watch effect supersedes any watch still held for that Thread.
          watches.get(effect.id)?.();
          const unwatch = dependencies.watch.watch(
            effect.id,
            effect.afterSequence,
            (update) => receive(effect.id, update),
          );
          watches.set(effect.id, unwatch);
        } else {
          watches.get(effect.id)?.();
          watches.delete(effect.id);
          // Events held for a released Thread belong to the watch that held them,
          // so they never land in a state a later watch opens.
          const flush = flushes.get(effect.id);
          if (flush !== undefined) clearTimeout(flush);
          flushes.delete(effect.id);
          // The cache absorbed every event the watch delivered, so the held
          // ones still reach it.
          writeEvents(effect.id, queued.get(effect.id));
          queued.delete(effect.id);
        }
      }
    };

    const commit = (
      effects: readonly ThreadChatEffect[],
      chats: ThreadChats,
    ) => {
      setChats(chats);
      applyEffects(effects);
    };

    /** Hands the history cache one Thread's events, as one batch. */
    function writeEvents(
      id: string,
      events: readonly ThreadEvent[] | undefined,
    ): void {
      if (events === undefined || events.length === 0) return;
      dependencies.history.write(
        id,
        events.map((event) => ({ kind: 'event', event })),
      );
    }

    /**
     * A stream's events are held until one flush carries them, while every other
     * update lands at once. The flush's wait is what keeps a burst from re-reading
     * the whole projection per event.
     */
    const schedule = (id: string): void => {
      if (flushes.has(id)) return;
      const elapsed = Date.now() - (flushedAt.get(id) ?? 0);
      flushes.set(
        id,
        setTimeout(() => drain(id), Math.max(0, STREAM_FLUSH_MS - elapsed)),
      );
    };

    const drain = (id: string): void => {
      flushes.delete(id);
      flushedAt.set(id, Date.now());
      const batch = queued.get(id);
      queued.delete(id);
      if (batch === undefined || batch.length === 0) return;
      const change = applyThreadEvents(get().chats, id, batch);
      commit(change.effects, change.chats);
      writeEvents(id, batch);
    };

    /** Reports one live update to the observer; never a stream failure. */
    const observe = (id: string, update: ThreadUpdate): void => {
      if (dependencies.observe === undefined) return;
      try {
        if (update.kind === 'event') {
          const thread = get().chats.chats.get(id)?.thread;
          if (thread === undefined) return;
          dependencies.observe({
            projectId: thread.projectId,
            threadId: id,
            threadName: thread.name,
            update,
          });
        } else if (update.kind === 'updated') {
          dependencies.observe({
            projectId: update.thread.projectId,
            threadId: id,
            threadName: update.thread.name,
            update,
          });
        }
      } catch {
        // An observer is never a failure of the stream.
      }
    };

    function receive(id: string, update: ThreadUpdate): void {
      if (queueChanged(update))
        for (const listener of queueListeners.get(id) ?? []) listener();
      observe(id, update);
      if (update.kind === 'event') {
        const batch = queued.get(id);
        if (batch === undefined) queued.set(id, [update.event]);
        else batch.push(update.event);
        schedule(id);
        return;
      }
      const change = applyThreadUpdate(get().chats, id, update);
      commit(change.effects, change.chats);
      dependencies.history.write(id, [update]);
    }

    /**
     * Sends through a Thread's request, holding the words as pending until the
     * host accepts them and reporting whether it did.
     */
    const send = async (
      id: string,
      request: (text: string) => Promise<unknown>,
      text: string,
    ): Promise<boolean> => {
      setChats(withSending(get().chats, id, true));
      setChats(withSendError(get().chats, id, undefined));
      try {
        await request(text);
        return true;
      } catch (reason) {
        setChats(withSendError(get().chats, id, messageFrom(reason)));
        return false;
      } finally {
        setChats(withSending(get().chats, id, false));
      }
    };

    /**
     * Sends the reader's words through one request — a prompt or a steer —
     * holding them as pending until the host accepts them. The Project names
     * where the stack flushes when this window has not opened the Thread.
     */
    const submit = async (
      id: string,
      text: string,
      request: (text: string) => Promise<PromptReceipt>,
      fallbackProjectId?: string,
    ): Promise<boolean> => {
      const words = text.trim();
      if (words.length === 0) return false;
      // The pending turn draws the reader's words, as the log's turn will —
      // the envelope's `<message>` — with the comments it carries above them.
      const comments = dependencies.comments?.(id, text) ?? [];
      setChats(startPending(get().chats, id, promptMessage(words), comments));
      // The receipt is what carries the flush: the host's prompt id, which
      // the comment events land below once the stack empties into them.
      let receipt: PromptReceipt | undefined;
      const accepted = await send(
        id,
        async (value) => {
          receipt = await request(value);
        },
        text,
      );
      // A refused send has nothing to wait for; the words go back, and the
      // stack above the prompt stays exactly where it was.
      if (!accepted) {
        setChats(clearPending(get().chats, id));
        return false;
      }
      if (receipt !== undefined) {
        // The flush runs only after the acceptance: the host took the prompt,
        // so each draft of the stack becomes a durable comment of this
        // prompt, and the stack empties into the log.
        // Until the log holds them, the comments are drawn as sent.
        const { promptId } = receipt;
        setChats(sendComments(get().chats, id, promptId, comments));
        const projectId =
          get().chats.chats.get(id)?.thread.projectId ?? fallbackProjectId;
        const written =
          projectId === undefined
            ? []
            : await dependencies.flush?.({
                threadId: id,
                projectId,
                promptId,
              });
        setChats(settleSentComments(get().chats, id, promptId, written ?? []));
      }
      return true;
    };

    return {
      chats: emptyThreadChats,

      open: (thread) => {
        const id = thread.id;
        // A deleted Thread stays deleted: the surface may still hold its record for
        // a render, and that render must not read its history or open a watch.
        if (get().chats.deleted.has(id)) return;
        // A Thread already held is only shown: its projection is live, so nothing
        // is read again and its watch is left alone.
        if (get().chats.chats.has(id)) {
          const change = showThread(get().chats, thread);
          commit(change.effects, change.chats);
          return;
        }
        // One history read per Thread, however many renders ask for it. The
        // Thread joins the most-recently-viewed order when the read lands, not
        // when the reader selected it: reads that resolve out of order can make
        // recency follow the network rather than the reader, which only matters
        // at the open-Thread bound.
        if (opening.has(id)) return;
        opening.add(id);
        const opened = epoch;
        void dependencies.threads
          .history(id)
          .catch(() => null)
          .then((history) => {
            if (opened !== epoch) return;
            opening.delete(id);
            // A second render may have opened it while the read was in flight.
            const change = openThread(get().chats, thread, history);
            commit(change.effects, change.chats);
          });
      },

      prompt: (id, text, options) =>
        submit(
          id,
          text,
          (value) => dependencies.threads.prompt(id, value),
          options?.projectId,
        ),

      steer: (id, text, options) =>
        submit(id, text, (value) =>
          dependencies.threads.steer(id, value, options),
        ),

      rewind: (id, promptId, text) =>
        send(
          id,
          (value) => dependencies.threads.rewind(id, promptId, value),
          text,
        ),

      retry: async (id) => {
        setChats(withSending(get().chats, id, true));
        setChats(withSendError(get().chats, id, undefined));
        try {
          await dependencies.threads.retry(id);
          return true;
        } catch (reason) {
          setChats(withSendError(get().chats, id, messageFrom(reason)));
          return false;
        } finally {
          setChats(withSending(get().chats, id, false));
        }
      },

      resume: async (id, promptId) => {
        setChats(withSending(get().chats, id, true));
        setChats(withSendError(get().chats, id, undefined));
        try {
          const thread = await dependencies.threads.resume(id, promptId);
          // The host's reply refreshes the Thread while the event stream catches up.
          const change = applyThreadUpdate(get().chats, id, {
            kind: 'updated',
            thread,
          });
          commit(change.effects, change.chats);
          return true;
        } catch (reason) {
          setChats(withSendError(get().chats, id, messageFrom(reason)));
          return false;
        } finally {
          setChats(withSending(get().chats, id, false));
        }
      },

      closeAll: () => {
        epoch += 1;
        for (const unwatch of watches.values()) unwatch();
        watches.clear();
        for (const flush of flushes.values()) clearTimeout(flush);
        flushes.clear();
        for (const [id, events] of queued) writeEvents(id, events);
        queued.clear();
        flushedAt.clear();
        opening.clear();
        setChats(emptyThreadChats);
      },
    };
  });
};

export type ThreadChatsStore = ReturnType<typeof createThreadChatsStore>;

/** The window's one store of opened chats, over the chat's host adapters. */
export const threadChatsStore: ThreadChatsStore = createThreadChatsStore({
  watch: threadWatch,
  threads: threadsApi,
  history: historyFeed,
  // The send flush: the composer's stack empties into the log once the host
  // accepted the prompt, with the writes the send performs (`api/composer.ts`).
  flush: (input) => composerFeed.flushAfterSend(input),
  comments: (id, text) =>
    sentComments(text, composerStackStore.getState().stack(id)),
  observe: (input) => {
    const hooks = chatHooks();
    if (hooks === undefined) return;
    void hooks.onThreadUpdateHook
      .execute(input as ThreadUpdateInput)
      .catch(() => undefined);
  },
});
