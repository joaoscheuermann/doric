// The chat's feed of `history.snapshots/v1` (D9-19): after each applied batch
// the conversation hands the cache the updates it received, so the cache
// holds what the main-process absorber held without a second host
// subscription. Events arrive at the store's flush, other updates at once;
// a stream failure is never cached. The cache is best effort: an absent
// provider or a failed write changes nothing.

import type { ThreadUpdate } from '../domain/workspace.js';
import { currentHistory } from '../services/chat-services.js';
import {
  type HistorySnapshots,
  historyUpdateFrom,
} from './history-contract.js';

export interface HistoryFeed {
  write(threadId: string, updates: readonly ThreadUpdate[]): void;
}

export const createHistoryFeed = (
  history: () => HistorySnapshots | undefined,
): HistoryFeed => ({
  write: (threadId, updates) => {
    const cached = updates.flatMap((update) => {
      const converted = historyUpdateFrom(update);
      return converted === undefined ? [] : [converted];
    });
    if (cached.length === 0) return;
    const target = history();
    if (target === undefined) return;
    try {
      void target.write({ threadId, updates: cached }).catch(() => undefined);
    } catch {
      // A cache failure is never a stream failure.
    }
  },
});

export const historyFeed: HistoryFeed = createHistoryFeed(currentHistory);
