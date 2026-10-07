import type { PromptProgress } from './prompts.js';
import { storageQueueError } from './storage-pause.js';
import type { InputSource, Thread } from './types.js';
import { isTerminal } from './types.js';

export interface QueueItem {
  readonly promptId: string;
  readonly source: InputSource;
  readonly label: string;
  readonly preview: string;
  readonly acceptedAt: string;
  readonly editable: boolean;
  readonly revision: number;
}

export interface QueuedPrompt {
  readonly promptId: string;
  readonly text: string;
  readonly revision: number;
  readonly editable: boolean;
}

export type EditQueueResult =
  | { readonly status: 'updated'; readonly prompt: QueuedPrompt }
  | {
      readonly status:
        | 'missing'
        | 'inactive'
        | 'unknown_prompt'
        | 'not_editable'
        | 'conflict'
        | 'invalid_prompt';
    };

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

export interface ThreadQueue {
  readonly error?: { readonly code: string; readonly message: string };
  readonly revision: number;
  readonly paused: boolean;
  readonly stopping: boolean;
  readonly current?: QueueItem;
  readonly resumable?: QueueItem;
  readonly items: readonly QueueItem[];
}

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
  const pending = inactive
    ? []
    : prompts.filter((prompt) => prompt.promptId !== thread.activePromptId);
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
