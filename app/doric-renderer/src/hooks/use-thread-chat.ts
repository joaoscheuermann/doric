import { useCallback, useEffect, useMemo } from 'react';
import { useStore } from 'zustand/react';

import type { PendingSend } from '@/domain/pending-turns';
import { emptyProjection, sandboxWrites, type Turn } from '@/domain/projector';
import { queueItems } from '@/domain/queue';
import type { Thread, ThreadEvent } from '@/domain/workspace';
import { useThreadQueue } from '@/hooks/use-thread-queue';
import { threadChatsStore } from '@/stores/thread-chats';

/** What a conversation surface needs from one Thread's chat. */
export type ThreadChat = {
  /** The Thread's record, kept live by the event stream. */
  readonly thread: Thread;
  /** Every event the Thread has, in durable order, deduplicated. */
  readonly events: readonly ThreadEvent[];
  /** The same log, projected into turns. */
  readonly turns: readonly Turn[];
  /**
   * How many finished `write`, `edit` or `terminal` calls the log holds: the
   * signal that the sandbox the Thread shares has changed.
   */
  readonly writes: number;
  /** A subscription failure, which the surface is expected to show. */
  readonly error: string | undefined;
  readonly sending: boolean;
  readonly sendError: string | undefined;
  /**
   * The words the reader has sent that the log does not hold yet, so a surface
   * can draw them at once. `undefined` when nothing is in flight.
   */
  readonly pending: PendingSend | undefined;
  /** Sends a prompt through `threads.prompt`, and reports whether it was accepted. */
  readonly prompt: (text: string) => Promise<boolean>;
  /** Replaces a past prompt through `threads.rewind`. */
  readonly rewind: (promptId: string, text: string) => Promise<boolean>;
  /** Takes up a paused prompt through `threads.resume`. */
  readonly resume: (promptId: string) => Promise<boolean>;
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
  const writes = useMemo(
    () => sandboxWrites(projection.events),
    [projection.events],
  );

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

  return {
    thread: chat?.thread ?? thread,
    events: projection.events,
    turns: projection.turns,
    writes,
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
    prompt,
    rewind,
    resume,
  };
};
