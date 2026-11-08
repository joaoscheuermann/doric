// The `papercraft.cwd/v1` events papercraft's host appends to a Thread's log
// are the Thread's working directory (D10), not something the conversation
// shows: this projector claims them and gives no block.

import type { ProjectorSpec } from '../contracts/chat.js';

export const cwdProjector: ProjectorSpec<null> = {
  eventTypes: ['papercraft.cwd/v1'],
  initial: () => null,
  reduce: (state) => ({ state, blocks: [] }),
};
