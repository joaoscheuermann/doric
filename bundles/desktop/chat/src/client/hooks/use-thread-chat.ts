import { useCallback, useEffect } from 'react';
import { useStore } from 'zustand/react';

import type { CommentThreads } from '../domain/comment-threads.js';
import type { PendingSend, SentComment } from '../domain/pending-turns.js';
import { emptyProjection, type Turn } from '../domain/projector.js';
import { queueItems } from '../domain/queue.js';
import type { Thread, ThreadEvent } from '../domain/workspace.js';
import { threadChatsStore } from '../stores/thread-chats.js';
import { useThreadQueue } from './use-thread-queue.js';

/** No sent comment waiting for the log: one frozen array, stable across renders. */
const noOutbox: readonly SentComment[] = [];

/** What a conversation surface needs from one Thread's chat. */
export type ThreadChat = {
  /** The Thread's record, kept live by the event stream. */
  readonly thread: Thread;
  /** Every event the Thread has, in durable order, deduplicated. */
  readonly events: readonly ThreadEvent[];
  /** The same log, projected into turns. */
  readonly turns: readonly Turn[];
  /** The log's comment threads, by root comment id, with their state. */
  readonly threads: CommentThreads;
  /** A subscription failure, which the surface is expected to show. */
  readonly error: string | undefined;
  readonly sending: boolean;
  readonly sendError: string | undefined;
  /**
   * The words the reader has sent that the log does not hold yet, so a surface
   * can draw them at once. `undefined` when nothing is in flight.
   */
  readonly pending: PendingSend | undefined;
  /**
   * The comments sent with accepted prompts that the log does not hold yet,
   * so a surface draws them from the send on.
   */
  readonly outbox: readonly SentComment[];
  /** Sends a prompt through `threads.prompt`, and reports whether it was accepted. */
  readonly prompt: (text: string) => Promise<boolean>;
  /**
   * Steers the running prompt through `threads.steer`; `interrupt` also aborts
   * its current step. With nothing running it sends a prompt instead.
   */
  readonly steer: (text: string, interrupt: boolean) => Promise<boolean>;
  /** Replaces a past prompt through `threads.rewind`. */
  readonly rewind: (promptId: string, text: string) => Promise<boolean>;
  /** Takes up a paused prompt through `threads.resume`. */
  readonly resume: (promptId: string) => Promise<boolean>;
  /**
   * Sends the Thread's last prompt again through `threads.retry`: the retry
   * lever on an agent Thread, where the reader writes nothing.
   */
  readonly retry: () => Promise<boolean>;
};

/**
 * One Thread's chat, read from the store that holds every opened Thread.
 *
 * The store opens a Thread from the local snapshot the main process kept — the
 * conversation is on screen before the stream answers — subscribes where that
 * snapshot ends, accumulates every event into the Thread's own ordered log, and
 * sends prompts. This hook only binds a surface to one Thread's slice of that
 * store, so switching Threads shows the state it already had: the Thread left
 * behind keeps its projection and its watch, and nothing is replayed.
 *
 * Two things about the log are worth knowing, and both happen in the store. It
 * is a merge, not a replacement: a reconnect replays only what follows the
 * cursor the subscription already holds, so an arriving snapshot is folded into
 * what is on screen. And it is ordered by `sequence`, then `createdAt`, then
 * `promptId`, with anything a rewind already discarded dropped — both of those
 * live in `projector.ts`.
 */
export const useThreadChat = (thread: Thread): ThreadChat => {
  const queue = useThreadQueue(thread.id);
  const open = threadChatsStore.getState().open;

  // Opening is idempotent: a Thread already held is only shown, so this runs on
  // every selection without resetting the Thread the surface came from.
  useEffect(() => {
    open(thread);
  }, [open, thread]);

  const chat = useStore(threadChatsStore, (state) =>
    state.chats.chats.get(thread.id),
  );
  const deleted = useStore(threadChatsStore, (state) =>
    state.chats.deleted.has(thread.id),
  );

  const projection = chat?.projection ?? emptyProjection;

  const prompt = useCallback(
    async (text: string) => {
      if (queue.data?.paused && queueItems(queue.data).length === 0) {
        try {
          await queue.resumeAsync();
        } catch {
          return false;
        }
      }
      return threadChatsStore.getState().prompt(thread.id, text);
    },
    [thread.id, queue.data, queue.resumeAsync],
  );
  const activePromptId = (chat?.thread ?? thread).activePromptId;
  const steer = useCallback(
    (text: string, interrupt: boolean) =>
      activePromptId === undefined
        ? prompt(text)
        : threadChatsStore.getState().steer(thread.id, text, {
            promptId: activePromptId,
            interrupt,
          }),
    [thread.id, activePromptId, prompt],
  );
  const rewind = useCallback(
    (promptId: string, text: string) =>
      threadChatsStore.getState().rewind(thread.id, promptId, text),
    [thread.id],
  );
  const resume = useCallback(
    (promptId: string) =>
      threadChatsStore.getState().resume(thread.id, promptId),
    [thread.id],
  );
  const retry = useCallback(
    () => threadChatsStore.getState().retry(thread.id),
    [thread.id],
  );

  return {
    thread: chat?.thread ?? thread,
    events: projection.events,
    turns: projection.turns,
    threads: projection.threads,
    // A Thread the surface no longer holds is one a `deleted` update dropped.
    error:
      chat !== undefined
        ? chat.error
        : deleted
          ? 'This thread was deleted.'
          : undefined,
    sending: chat?.sending ?? false,
    sendError: chat?.sendError,
    pending: chat?.pending,
    outbox: chat?.outbox ?? noOutbox,
    prompt,
    steer,
    rewind,
    resume,
    retry,
  };
};
