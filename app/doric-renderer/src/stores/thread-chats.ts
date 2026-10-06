import { promptCompletion, watchingCompletion } from '@/domain/notifications';
import { queueChanged } from '@/domain/queue';
import {
  applyThreadEvents,
  applyThreadUpdate,
  clearPending,
  emptyThreadChats,
  openThread,
  showThread,
  startPending,
  type ThreadChatEffect,
  type ThreadChats,
  withSendError,
  withSending,
} from '@/domain/thread-chats';
import {
  messageFrom,
  type Thread,
  type ThreadEvent,
  type ThreadUpdate,
} from '@/domain/workspace';
import { createStore } from 'zustand/vanilla';

import { selectionStore } from './selection';

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
  /** Sends a prompt from a Thread, recording it as pending until accepted. */
  readonly prompt: (id: string, text: string) => Promise<boolean>;
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
};

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

export const threadChatsStore = createStore<ThreadChatsState>()((set, get) => {
  const setChats = (chats: ThreadChats): void => set({ chats });

  /** Runs the effects a change asked for: opening or releasing one watch each. */
  const applyEffects = (effects: readonly ThreadChatEffect[]): void => {
    for (const effect of effects) {
      if (effect.kind === 'watch') {
        // A watch effect supersedes any watch still held for that Thread.
        watches.get(effect.id)?.();
        const unwatch = window.doric.threads.watch(
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
        queued.delete(effect.id);
      }
    }
  };

  const commit = (effects: readonly ThreadChatEffect[], chats: ThreadChats) => {
    setChats(chats);
    applyEffects(effects);
  };

  /**
   * Shows the native notification one live event of a Thread deserves. It is a
   * courtesy of the chat and never a failure of the stream: a Thread the surface
   * no longer holds has no name to wear, and a main process that drops the
   * notification changes nothing about the log.
   */
  const announce = (id: string, event: ThreadEvent): void => {
    const thread = get().chats.chats.get(id)?.thread;
    if (thread === undefined) return;
    const notification = promptCompletion(event, thread.name);
    if (notification === undefined) return;
    // A reader looking at this Thread is reading it, not waiting to be told about
    // it; every other Thread's completion is still announced.
    const shown = selectionStore.getState().selectedThreadId;
    if (watchingCompletion(id, shown, document.hasFocus())) return;
    void window.doric.notifications.show(notification).catch(() => undefined);
  };

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
  };

  function receive(id: string, update: ThreadUpdate): void {
    if (queueChanged(update))
      for (const listener of queueListeners.get(id) ?? []) listener();
    if (update.kind === 'event') {
      // Only a live event is announced: a snapshot replays history the reader has
      // already seen, and replaying it would notify a completion again.
      announce(id, update.event);
      queued.set(id, [...(queued.get(id) ?? []), update.event]);
      schedule(id);
      return;
    }
    const change = applyThreadUpdate(get().chats, id, update);
    commit(change.effects, change.chats);
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
      void window.doric.threads
        .history(id)
        .catch(() => null)
        .then((history) => {
          opening.delete(id);
          // A second render may have opened it while the read was in flight.
          const change = openThread(get().chats, thread, history);
          commit(change.effects, change.chats);
        });
    },

    prompt: async (id, text) => {
      const words = text.trim();
      if (words.length === 0) return false;
      setChats(startPending(get().chats, id, words));
      const accepted = await send(
        id,
        (value) => window.doric.threads.prompt(id, value),
        text,
      );
      // A refused send has nothing to wait for; the words go back.
      if (!accepted) setChats(clearPending(get().chats, id));
      return accepted;
    },

    rewind: (id, promptId, text) =>
      send(
        id,
        (value) => window.doric.threads.rewind(id, promptId, value),
        text,
      ),

    resume: async (id, promptId) => {
      setChats(withSending(get().chats, id, true));
      setChats(withSendError(get().chats, id, undefined));
      try {
        const thread = await window.doric.threads.resume(id, promptId);
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
  };
});
