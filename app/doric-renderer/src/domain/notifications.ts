import type { ThreadEvent } from '@/domain/workspace';

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

const record = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : undefined;

/** What each terminal status a `prompt.finished` carries reads as. */
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
 * deserves none.
 *
 * `prompt.finished` is the one event that closes a prompt — it carries the
 * terminal status, and the host's contract is that clients acknowledge prompt
 * completion by it rather than by the inner `agent.finished` — so every other
 * event of the log is silent. The title names the Thread the prompt belongs to,
 * because several run at once, and the body names the outcome beside the answer
 * that closed it. Replayed events are not this rule's business: a surface that
 * replays a Thread's log asks this only about what arrives live.
 */
export const promptCompletion = (
  event: ThreadEvent,
  threadName: string,
): PromptNotification | undefined => {
  if (event.type !== 'prompt.finished') return undefined;
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
 * the Thread the workspace shows, with the window focused. Telling them about
 * something they are reading is the noise a notice should not make, while a
 * Thread nobody shows — or a window some other window has taken the focus from —
 * is not being read, and is still worth a notice.
 *
 * The selection and the focus are the surface's own facts, so they arrive as
 * arguments and this stays a rule about them.
 */
export const watchingCompletion = (
  threadId: string,
  shownThreadId: string | undefined,
  windowFocused: boolean,
): boolean => windowFocused && threadId === shownThreadId;
