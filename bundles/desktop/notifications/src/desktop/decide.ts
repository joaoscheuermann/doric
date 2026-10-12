// The decision behind a native notice (moved from the renderer's
// `domain/notifications.ts`). The one change: the event type check also
// accepts the bundle-architecture name `runtime.prompt-finished/v1`
// (decision "Eventos").

import type { PromptObservation, ThreadEvent } from '../contracts/index.js';

/**
 * How long the answer's own line may be, before a notification is all preview
 * and no outcome.
 */
export const NOTIFICATION_LINE_LIMIT = 160;

/** The two lines one native notification draws. */
export type PromptNotification = {
  readonly title: string;
  readonly body: string;
};

const PROMPT_FINISHED = new Set([
  'prompt.finished',
  'runtime.prompt-finished/v1',
]);

const record = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : undefined;

/** What each terminal status a finished prompt carries reads as. */
const statusLine = (status: unknown): string => {
  if (status === 'failed') return 'Prompt failed';
  if (status === 'cancelled') return 'Prompt cancelled';
  return 'Prompt completed';
};

/** The answer as one bounded line, or empty when it states nothing. */
const preview = (value: unknown): string => {
  if (typeof value !== 'string') return '';
  const oneLine = value.replace(/\s+/g, ' ').trim();
  return Array.from(oneLine).slice(0, NOTIFICATION_LINE_LIMIT).join('');
};

/**
 * The notification one live event of a Thread deserves, or `undefined` when it
 * deserves none: only the event that closes a prompt is announced, titled by
 * the Thread and naming the outcome beside the answer.
 */
export const promptCompletion = (
  event: ThreadEvent,
  threadName: string,
): PromptNotification | undefined => {
  if (!PROMPT_FINISHED.has(event.type)) return undefined;
  const payload = record(event.event);
  const line = preview(payload?.text);
  const outcome = statusLine(payload?.status);
  return {
    title: threadName,
    body: line === '' ? outcome : `${outcome} · ${line}`,
  };
};

/**
 * Whether the reader is already looking at the Thread a completion belongs to:
 * the Thread the window shows, with the window focused.
 */
export const watchingCompletion = (
  threadId: string,
  shownThreadId: string | undefined,
  windowFocused: boolean,
): boolean => windowFocused && threadId === shownThreadId;

/**
 * Shows the notice one observation deserves. Failing to show it is swallowed,
 * as the renderer did: the completion stays in the Thread's own log.
 */
export const report = async (
  observation: PromptObservation,
  show: (notification: PromptNotification) => Promise<void>,
): Promise<void> => {
  if (
    watchingCompletion(
      observation.threadId,
      observation.shownThreadId,
      observation.windowFocused,
    )
  )
    return;
  const notification = promptCompletion(
    observation.event,
    observation.threadName,
  );
  if (notification === undefined) return;
  try {
    await show(notification);
  } catch {
    // A notice is a courtesy; its failure changes nothing.
  }
};
