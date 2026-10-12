// The chat's binding to `history.snapshots/v1` (D9-19), the desktopMain cache
// the `history` bundle provides: its snapshot is the conversation's
// `ThreadHistory`, and each update the conversation applied is handed over in
// the history bundle's flat shape (a snapshot update carries its record and
// events, not the whole namespace payload). The history bundle is optional
// (`whenAvailable`), so only its types are imported: a value import would
// make the window load `history/contracts`, which a composition without that
// bundle does not map. The reference repeats its ID.

import { ref } from 'bundle/contracts';
import type { HistorySnapshots, HistoryUpdate } from 'history/contracts';

import type { ThreadHistory, ThreadUpdate } from '../domain/workspace.js';

export type { HistorySnapshots } from 'history/contracts';

export const HistorySnapshotsV1 = ref<HistorySnapshots>('history.snapshots/v1');

/** The cached snapshot as the conversation reads it. */
export const threadHistoryFrom = (
  snapshot: Awaited<ReturnType<HistorySnapshots['read']>>,
): ThreadHistory | null => snapshot as ThreadHistory | null;

/** One applied update in the cache's shape; a stream failure is never cached. */
export const historyUpdateFrom = (
  update: ThreadUpdate,
): HistoryUpdate | undefined => {
  switch (update.kind) {
    case 'snapshot':
      return {
        kind: 'snapshot',
        thread: update.snapshot.thread,
        events: [...update.snapshot.events],
      };
    case 'event':
      return { kind: 'event', event: update.event };
    case 'updated':
      return { kind: 'updated', thread: update.thread };
    case 'deleted':
      return {
        kind: 'deleted',
        projectId: update.projectId,
        threadId: update.threadId,
      };
    case 'error':
      return undefined;
  }
};
