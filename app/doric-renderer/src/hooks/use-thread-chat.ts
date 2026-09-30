import type { PendingSend } from '@/domain/pending-turns';
import {
  emptyProjection,
  projectEvents,
  sandboxWrites,
  type Turn,
} from '@/domain/projector';
import { messageFrom, type Thread, type ThreadEvent } from '@/domain/workspace';
import { useCallback, useEffect, useMemo, useState } from 'react';

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
 * It subscribes when the Thread opens, accumulates every event it receives into
 * one ordered log, exposes that log and its projection, and sends prompts. It
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
    return window.doric.threads.watch(thread.id, 0, (update) => {
      if (update.kind === 'snapshot') {
        setProjection((current) =>
          projectEvents(current, update.snapshot.events),
        );
        if (update.snapshot.thread !== null) setRecord(update.snapshot.thread);
      } else if (update.kind === 'event') {
        setProjection((current) => projectEvents(current, [update.event]));
      } else if (update.kind === 'updated') {
        setRecord(update.thread);
      } else if (update.kind === 'error') {
        setError(update.message);
      } else if (update.kind === 'deleted') {
        setError('This thread was deleted.');
      }
    });
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
