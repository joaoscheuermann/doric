import type { PendingSend } from '@/domain/pending-turns';
import {
  emptyProjection,
  projectEvents,
  sandboxWrites,
  type Turn,
} from '@/domain/projector';
import {
  messageFrom,
  type Thread,
  type ThreadEvent,
  type ThreadHistory,
} from '@/domain/workspace';
import { useCallback, useEffect, useMemo, useState } from 'react';

/**
 * How long a stream's events wait before they reach the projection. A live run
 * writes its log thousands of events at a time, and every event that reached the
 * projection would re-read the whole of it — the cost a whole run pays, not one
 * event. A flush carries a burst instead, and the first event of one lands at
 * once, so a turn the reader is waiting for is not the one that waits.
 */
const STREAM_FLUSH_MS = 100;

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
};

/**
 * The lifecycle of one Thread's chat, and the only place that reads its events.
 *
 * It opens a Thread from the local snapshot the main process kept — the
 * conversation is on screen before the stream answers — then subscribes where
 * that snapshot ends, accumulates every event it receives into one ordered log,
 * exposes that log and its projection, and sends prompts. It
 * renders nothing: a conversation surface is free to read the events and decide
 * what to do with them, which is the whole point of keeping the pipeline here.
 *
 * Two things about this log are worth knowing. It is a merge, not a replacement:
 * a reconnect replays only what follows the cursor the subscription already
 * holds, so an arriving snapshot is folded into what is on screen. And it is
 * ordered by `sequence`, then `createdAt`, then `promptId`, with anything a
 * rewind already discarded dropped — both of those live in `projector.ts`.
 */
export const useThreadChat = (thread: Thread): ThreadChat => {
  const [record, setRecord] = useState(thread);
  const [projection, setProjection] = useState(emptyProjection);
  const [error, setError] = useState<string>();
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string>();
  const [sent, setSent] = useState<PendingSend>();

  useEffect(() => {
    // A new Thread reopens the surface: every piece of per-Thread state goes
    // back to what a fresh mount would hold, so the hook is correct on its own
    // instead of relying on the pane remounting it with a `key`. The reset reads
    // the Thread of the render that changed it; the subscription restarts only
    // when the id changes, so renaming a Thread does not reopen its log.
    setRecord(thread);
    setProjection(emptyProjection);
    setError(undefined);
    setSendError(undefined);
    setSending(false);
    setSent(undefined);

    // A stream's events are held until one flush carries them, and a flush waits
    // out the window before the last one unless nothing has flushed for longer.
    const queued: ThreadEvent[] = [];
    let flush: ReturnType<typeof setTimeout> | undefined;
    let flushedAt = 0;
    let unwatch: (() => void) | undefined;
    let closed = false;

    const drain = (): void => {
      flush = undefined;
      flushedAt = Date.now();
      const batch = queued.splice(0);
      if (batch.length > 0) {
        setProjection((current) => projectEvents(current, batch));
      }
    };

    // The conversation is drawn from the local snapshot the main process kept
    // before the stream answers, and the subscription picks up where that
    // snapshot ends — or replays the whole log when the app holds none. Either
    // way, what arrives merges into what is on screen.
    const subscribe = (cached: ThreadHistory | null): void => {
      if (closed) return;
      if (cached !== null) {
        if (cached.thread !== null) setRecord(cached.thread);
        setProjection(projectEvents(emptyProjection, cached.events));
      }
      unwatch = window.doric.threads.watch(
        thread.id,
        cached?.lastSequence ?? 0,
        (update) => {
          if (update.kind === 'snapshot') {
            setProjection((current) =>
              projectEvents(current, update.snapshot.events),
            );
            if (update.snapshot.thread !== null)
              setRecord(update.snapshot.thread);
          } else if (update.kind === 'event') {
            queued.push(update.event);
            if (flush === undefined) {
              flush = setTimeout(
                drain,
                Math.max(0, STREAM_FLUSH_MS - (Date.now() - flushedAt)),
              );
            }
          } else if (update.kind === 'updated') {
            setRecord(update.thread);
          } else if (update.kind === 'error') {
            setError(update.message);
          } else if (update.kind === 'deleted') {
            setError('This thread was deleted.');
          }
        },
      );
    };

    // A cache read that lands after the surface moved on is ignored.
    void window.doric.threads
      .history(thread.id)
      .then(subscribe)
      .catch(() => subscribe(null));

    return () => {
      closed = true;
      if (flush !== undefined) clearTimeout(flush);
      unwatch?.();
    };
  }, [thread.id]);

  const send = useCallback(
    async (
      request: (text: string) => Promise<unknown>,
      text: string,
    ): Promise<boolean> => {
      if (text.trim().length === 0) return false;
      setSending(true);
      setSendError(undefined);
      try {
        await request(text);
        return true;
      } catch (reason) {
        setSendError(messageFrom(reason));
        return false;
      } finally {
        setSending(false);
      }
    },
    [],
  );

  // The reader's own prompts in the log: one more of them than there were when a
  // send left is that send accepted, whatever else the log has done since.
  const ownPrompts = useMemo(
    () =>
      projection.turns.filter(
        (turn) => turn.type === 'user' && turn.delegated === undefined,
      ).length,
    [projection.turns],
  );

  const prompt = useCallback(
    async (text: string): Promise<boolean> => {
      const words = text.trim();
      if (words.length === 0) return false;
      // Drawn at once: the words leave the prompt before the log holds them, so
      // the surface shows them as the turn they are about to become.
      setSent({ text: words, before: ownPrompts });
      const accepted = await send(
        (value) => window.doric.threads.prompt(record.id, value),
        text,
      );
      // A refused send has nothing to wait for; the surface puts the words back
      // into the prompt.
      if (!accepted) setSent(undefined);
      return accepted;
    },
    [ownPrompts, record.id, send],
  );

  const rewind = useCallback(
    (promptId: string, text: string) =>
      send(
        (value) => window.doric.threads.rewind(record.id, promptId, value),
        text,
      ),
    [record.id, send],
  );

  const writes = useMemo(
    () => sandboxWrites(projection.events),
    [projection.events],
  );

  // The words stop being pending once the log has accepted one more prompt of
  // the reader's own; the state is dropped then, and the surface stops drawing
  // them in the same render the accepted turn appears.
  useEffect(() => {
    if (sent !== undefined && ownPrompts > sent.before) setSent(undefined);
  }, [ownPrompts, sent]);

  return {
    thread: record,
    events: projection.events,
    turns: projection.turns,
    writes,
    error,
    sending,
    sendError,
    pending: sent,
    prompt,
    rewind,
  };
};
