import {
  emptyProjection,
  projectEvents,
  type PromptTurn,
} from '@/domain/projector';
import { messageFrom, type Thread, type ThreadEvent } from '@/domain/workspace';
import { useCallback, useEffect, useState } from 'react';

/** What a conversation surface needs from one Thread's chat. */
export type ThreadChat = {
  /** The Thread's record, kept live by the event stream. */
  readonly thread: Thread;
  /** Every event the Thread has, in durable order, deduplicated. */
  readonly events: readonly ThreadEvent[];
  /** The same log, projected into turns. */
  readonly turns: readonly PromptTurn[];
  /** A subscription failure, which the surface is expected to show. */
  readonly error: string | undefined;
  readonly sending: boolean;
  readonly sendError: string | undefined;
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

  useEffect(() => {
    setProjection(emptyProjection);
    setError(undefined);
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

  const prompt = useCallback(
    (text: string) =>
      send((value) => window.doric.threads.prompt(record.id, value), text),
    [record.id, send],
  );

  const rewind = useCallback(
    (promptId: string, text: string) =>
      send(
        (value) => window.doric.threads.rewind(record.id, promptId, value),
        text,
      ),
    [record.id, send],
  );

  return {
    thread: record,
    events: projection.events,
    turns: projection.turns,
    error,
    sending,
    sendError,
    prompt,
    rewind,
  };
};
