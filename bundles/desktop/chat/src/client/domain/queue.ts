import { withAttachmentPlaceholders } from 'runtime/contracts';

import { READER_NAME } from './conversation-authors.js';
import {
  parsePromptEnvelope,
  previewSummary,
  promptSummary,
} from './prompt-envelope.js';
import type { ThreadEvent, ThreadUpdate } from './workspace.js';

export interface QueueItem {
  readonly promptId: string;
  readonly source: {
    readonly kind: 'user' | 'terminal' | 'parent' | 'result';
    readonly threadId?: string;
    readonly terminalId?: string;
  };
  readonly label: string;
  readonly preview: string;
  readonly acceptedAt: string;
  readonly editable?: boolean;
  readonly revision?: number;
}
export interface QueuedPrompt {
  readonly promptId: string;
  readonly text: string;
  readonly revision: number;
  readonly editable: boolean;
}
export interface ThreadQueue {
  readonly error?: { readonly code: string; readonly message: string };
  readonly revision: number;
  readonly paused: boolean;
  readonly stopping: boolean;
  readonly current?: QueueItem;
  readonly resumable?: QueueItem;
  readonly items: readonly QueueItem[];
}

/** The current input followed by the pending FIFO. */
export const queueItems = (
  queue: ThreadQueue | undefined,
): readonly QueueItem[] => {
  if (queue === undefined) return [];
  const current = queue.current ?? queue.resumable;
  return current === undefined ? queue.items : [current, ...queue.items];
};

/**
 * The rows the queue block shows: only what is enqueued. The running prompt
 * is already the transcript's last turn, and a paused one is resumed from its
 * marker there.
 */
export const visibleQueueItems = (
  queue: ThreadQueue | undefined,
): readonly QueueItem[] => queue?.items ?? [];

export const composerAction = (
  running: boolean,
  queue: ThreadQueue | undefined,
): 'send' | 'resume' | 'pause' =>
  running || queue?.stopping === true
    ? 'pause'
    : queueItems(queue).length > 0
      ? 'resume'
      : 'send';

/** One author identity for both the live queue and its historical receipts. */
export const queueAuthor = (
  source: QueueItem['source'],
  label?: string,
): string =>
  source.kind === 'user'
    ? READER_NAME
    : (label ??
      (source.kind === 'terminal'
        ? 'Terminal'
        : `${source.kind === 'parent' ? 'Parent' : 'Subthread'} · ${source.threadId?.slice(0, 8) ?? 'unknown'}`));

const changes = new Set([
  'prompt.accepted',
  'prompt.edited',
  'prompt.queued',
  'prompt.started',
  'prompt.resumed',
  'prompt.paused',
  'prompt.finished',
  'prompt.steered',
  'agent.started',
  'queue.updated',
  'queue.paused',
  'queue.resumed',
  'history.truncated',
]);
export const queueChanged = (update: ThreadUpdate): boolean =>
  update.kind === 'snapshot' ||
  update.kind === 'updated' ||
  update.kind === 'deleted' ||
  (update.kind === 'event' && changes.has(update.event.type));

/** An older request can settle after a newer snapshot has already arrived. */
export const latestQueue = (
  previous: ThreadQueue | undefined,
  next: ThreadQueue,
): ThreadQueue =>
  previous !== undefined && previous.revision > next.revision ? previous : next;

/** The text a queued prompt was accepted with, or last edited to. */
export const queueDetail = (
  events: readonly ThreadEvent[],
  promptId: string,
): string | undefined => {
  // Read from the end without copying the log: the selector runs on every
  // update of the Thread's chat, once per row.
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (
      event === undefined ||
      event.promptId !== promptId ||
      (event.type !== 'prompt.accepted' && event.type !== 'prompt.edited')
    )
      continue;
    const payload = event.event;
    return payload !== null &&
      typeof payload === 'object' &&
      'text' in payload &&
      typeof payload.text === 'string'
      ? payload.text
      : undefined;
  }
  return undefined;
};

/**
 * The words a queued item's details show: a reader's prompt as its words (or,
 * for comments alone, their notes), read from the stored text when the log
 * holds it and from the host's preview otherwise; any other source as is.
 */
export const queueItemText = (
  item: QueueItem,
  stored: string | undefined,
): string => {
  if (item.source.kind !== 'user') return stored ?? item.preview;
  return withAttachmentPlaceholders(
    stored === undefined ? previewSummary(item.preview) : promptSummary(stored),
  );
};

/**
 * The one line a queue row shows for an item: the host's preview, except for
 * a reader's envelope, whose words the row reads from the stored text.
 */
export const queueRowText = (
  item: QueueItem,
  stored: string | undefined,
): string => {
  if (item.source.kind !== 'user') return item.preview;
  if (stored !== undefined && parsePromptEnvelope(stored) !== undefined)
    return withAttachmentPlaceholders(promptSummary(stored))
      .replace(/\s+/g, ' ')
      .trim();
  return withAttachmentPlaceholders(previewSummary(item.preview));
};
