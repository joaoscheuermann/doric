import {
  isTerminal,
  type QueuedPrompt,
  type QueueItem,
  storageMessage,
  type Thread,
  type ThreadQueue,
} from '../../contracts/model.js';
import type { PromptProgress } from './types.js';

/*
 * The queue snapshot `ThreadStore.queue` answers, ported verbatim from
 * agents/doric/src/lib/workspace/queue.ts. It lives with the store because
 * the store composes it from one consistent read; the domain imports it
 * from here for the edit and remove paths.
 */

/** The queue error a storage pause shows, as `storage-pause.ts` defines it. */
export const storageQueueError = {
  code: 'storage_low',
  message: storageMessage,
} as const;

export const queuedPrompt = (prompt: PromptProgress): QueuedPrompt => ({
  promptId: prompt.promptId,
  text: prompt.text,
  revision: prompt.revision ?? 0,
  editable:
    prompt.source.kind === 'user' &&
    !prompt.started &&
    prompt.paused === undefined &&
    !prompt.superseded,
});

/** The last reader pause is resumed first; older pauses remain in the history. */
export const resumablePrompt = (prompts: readonly PromptProgress[]) =>
  prompts
    .filter(
      (prompt) =>
        !prompt.superseded &&
        (prompt.paused === 'reader_stopped' || prompt.paused === 'storage_low'),
    )
    .sort((a, b) => (b.pausedSequence ?? 0) - (a.pausedSequence ?? 0))[0];

export const queuedPrompts = (prompts: readonly PromptProgress[]) =>
  prompts
    .filter(
      (prompt) =>
        !prompt.superseded &&
        prompt.paused !== 'reader_stopped' &&
        prompt.paused !== 'storage_low',
    )
    .sort(
      (a, b) =>
        Number(b.first === true) - Number(a.first === true) ||
        (a.queuedSequence ?? 0) - (b.queuedSequence ?? 0),
    );

/** Bounded display text; the durable accepted event remains the full detail. */
const item = (
  prompt: PromptProgress,
  names: ReadonlyMap<string, string>,
): QueueItem => {
  const source = prompt.source;
  const command =
    source.kind === 'terminal'
      ? /^Command: (.*)$/m.exec(prompt.text)?.[1]
      : undefined;
  const label =
    source.kind === 'user'
      ? 'You'
      : source.kind === 'terminal'
        ? 'Terminal'
        : source.kind === 'bundle'
          ? `${source.bundleId} · ${source.reason}`
          : `${source.kind === 'result' ? 'Subthread' : 'Parent'} · ${names.get(source.threadId) ?? source.threadId.slice(0, 8)}`;
  return {
    promptId: prompt.promptId,
    source,
    label,
    preview: (command ?? prompt.text).replace(/\s+/g, ' ').trim().slice(0, 240),
    acceptedAt: prompt.acceptedAt ?? '',
    editable: queuedPrompt(prompt).editable,
    revision: prompt.revision ?? 0,
  };
};

export const queueSnapshot = (
  thread: Thread,
  prompts: readonly PromptProgress[],
  names: ReadonlyMap<string, string>,
): ThreadQueue => {
  const inactive = isTerminal(thread.state) || thread.state === 'cancelling';
  // A steering input waiting for the running prompt is not queued work.
  const pending = inactive
    ? []
    : prompts.filter(
        (prompt) =>
          prompt.promptId !== thread.activePromptId &&
          (prompt.steer === undefined ||
            prompt.steer !== thread.activePromptId),
      );
  const resumable = resumablePrompt(pending);
  const current = inactive
    ? undefined
    : (prompts.find((prompt) => prompt.promptId === thread.activePromptId) ??
      resumable);
  return {
    revision: thread.lastSequence,
    ...(!inactive && thread.errorCode === 'storage_low'
      ? { error: storageQueueError }
      : {}),
    paused: !inactive && thread.queuePaused === true,
    stopping:
      !inactive &&
      thread.queuePaused === true &&
      thread.activePromptId !== undefined,
    ...(current === undefined ? {} : { current: item(current, names) }),
    ...(resumable === undefined ? {} : { resumable: item(resumable, names) }),
    items: queuedPrompts(pending).map((prompt) => item(prompt, names)),
  };
};
