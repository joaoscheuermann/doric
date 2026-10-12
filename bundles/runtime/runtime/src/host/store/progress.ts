import { type InputSource, inputSourceSchema } from '../../contracts/model.js';
import type { PendingPrompt } from '../../contracts/storage.js';
import type { PauseReason, PromptProgress } from './types.js';

/*
 * The `pending` projection of a Thread document (design 57 §3.5): its
 * unfinished prompts, ported line by line from the former
 * `unfinishedPrompts` fold (agents/doric/src/lib/workspace/threads.ts). The
 * append path applies it to each new entry inside the same commit; a
 * document without the projection (`pending: null`, written by the stage-7
 * import) and a rewind apply it as a left fold over the stream. Both use
 * this one function, so the incremental and the full fold agree by
 * construction.
 */

/** One stream entry as the fold reads it. */
export interface ProgressEntry {
  readonly sequence: number;
  readonly promptId: string;
  readonly type: string;
  readonly event: unknown;
  readonly createdAt: string;
}

/** The event types that decide whether a prompt is unfinished, and how. */
export const progressTypes: readonly string[] = [
  'prompt.accepted',
  'prompt.edited',
  'prompt.started',
  'prompt.finished',
  'prompt.paused',
  'prompt.resumed',
  'agent.started',
];

const pauseReasons: readonly PauseReason[] = [
  'storage_low',
  'host_stopped',
  'host_restarted',
  'reader_stopped',
];

const isPauseReason = (value: unknown): value is PauseReason =>
  (pauseReasons as readonly unknown[]).includes(value);

/** A field of the event body, when the body is an object. */
const field = (event: unknown, key: string): unknown =>
  typeof event === 'object' && event !== null
    ? (event as Record<string, unknown>)[key]
    : undefined;

type Mutable<T> = { -readonly [Key in keyof T]: T[Key] };

/**
 * The pending prompts after one more entry. Only a prompt this fold accepted
 * can be unfinished, and it cannot be closed before it was accepted;
 * `prompt.finished` is the one event that closes a turn. A user (or
 * source-less) input that is not queued supersedes every paused prompt of
 * the Thread.
 */
export const foldProgress = (
  pending: readonly PendingPrompt[],
  entry: ProgressEntry,
): readonly PendingPrompt[] => {
  if (!progressTypes.includes(entry.type)) return pending;
  const index = pending.findIndex(
    ({ promptId }) => promptId === entry.promptId,
  );
  if (entry.type === 'prompt.accepted') {
    if (index !== -1) return pending;
    const text = field(entry.event, 'text');
    const rawSource = field(entry.event, 'source');
    const supersedes =
      field(entry.event, 'queued') !== true &&
      (rawSource === undefined || field(rawSource, 'kind') === 'user');
    const next: PendingPrompt[] = pending.map((previous) =>
      supersedes && previous.paused !== undefined
        ? { ...previous, superseded: true }
        : previous,
    );
    next.push({
      promptId: entry.promptId,
      // The former fold kept whatever the event held; the document schema
      // takes text and a valid source, which every runtime write carries.
      text: typeof text === 'string' ? text : '',
      revision: entry.sequence,
      source:
        rawSource !== undefined &&
        inputSourceSchema.safeParse(rawSource).success
          ? (rawSource as InputSource)
          : { kind: 'user' },
      started: false,
      attempts: 0,
      acceptedAt: entry.createdAt,
      acceptedSequence: entry.sequence,
      queuedSequence: entry.sequence,
    });
    return next;
  }
  const current = pending[index];
  if (current === undefined) return pending;
  if (entry.type === 'prompt.finished')
    return pending.filter((_, position) => position !== index);
  const progress: Mutable<PendingPrompt> = { ...current };
  if (entry.type === 'agent.started' || entry.type === 'prompt.started')
    progress.started = true;
  else if (entry.type === 'prompt.edited') {
    const text = field(entry.event, 'text');
    if (typeof text !== 'string') return pending;
    progress.text = text;
    progress.revision = entry.sequence;
  } else if (entry.type === 'prompt.resumed') {
    progress.attempts += 1;
    delete progress.paused;
    progress.queuedSequence = entry.sequence;
    progress.first = field(entry.event, 'first') === true;
  } else {
    const reason = field(entry.event, 'reason');
    if (!isPauseReason(reason)) return pending;
    progress.paused = reason;
    progress.pausedSequence = entry.sequence;
  }
  return pending.map((previous, position) =>
    position === index ? progress : previous,
  );
};

/** The fold over a whole stream, from nothing. */
export const foldAll = (
  entries: readonly ProgressEntry[],
): readonly PendingPrompt[] => entries.reduce(foldProgress, []);

/** One pending prompt as the domain reads it, with its Thread and Project. */
export const toProgress = (
  projectId: string,
  threadId: string,
  pending: PendingPrompt,
): PromptProgress => {
  const { acceptedSequence: _acceptedSequence, ...rest } = pending;
  return { projectId, threadId, ...rest };
};

/** The correlated result a delegated prompt delivers to its parent. */
export const delegatedResult = (
  threadId: string,
  promptId: string,
  requestPromptId: string,
  status: string,
  text: string,
): string =>
  [
    '# Delegated task result',
    '',
    `Child thread: ${threadId}`,
    `Child prompt: ${promptId}`,
    `Originating prompt: ${requestPromptId}`,
    `Status: ${status}`,
    '',
    '## Result',
    '',
    text,
  ].join('\n');
