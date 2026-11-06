// The old ask rows (conversation-openui.md D30): threads 2.0.0 has no `ask`,
// but Threads still hold `threads.asked/v1` and `threads.answered/v1` rows.
// This projector claims both so they replay without a block and without an
// "unknown event" fallback.

import type { ProjectorSpec } from './chat-contract.js';

/** Claims the two old ask event types and draws nothing for them. */
export const oldAskProjector: ProjectorSpec<null> = {
  eventTypes: ['threads.asked/v1', 'threads.answered/v1'],
  initial: () => null,
  reduce: (state) => ({ state, blocks: [] }),
};
