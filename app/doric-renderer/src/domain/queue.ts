import { READER_NAME } from './conversation-authors';
import type { ThreadEvent, ThreadUpdate } from './workspace';

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

/** Running input alone already appears in the transcript; paused work stays visible. */
export const visibleQueueItems = (
  queue: ThreadQueue | undefined,
): readonly QueueItem[] =>
  queue !== undefined &&
  (queue.paused ||
    queue.stopping ||
    queue.resumable !== undefined ||
    queue.items.length > 0)
    ? queueItems(queue)
    : [];

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

export const queueDetail = (
  events: readonly ThreadEvent[],
  promptId: string,
): string | undefined => {
  const event = [...events]
    .reverse()
    .find(
      (event) =>
        event.promptId === promptId &&
        (event.type === 'prompt.accepted' || event.type === 'prompt.edited'),
    )?.event;
  return event !== null &&
    typeof event === 'object' &&
    'text' in event &&
    typeof event.text === 'string'
    ? event.text
    : undefined;
};
