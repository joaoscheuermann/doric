// The `artifacts.*` rows old Threads still hold (D25, PC21): stage 4 removed
// the artifacts bundle, so nothing projects them any more. This projector
// claims them and gives no block, so they replay as nothing instead of a
// generic block.

import type { ProjectorSpec } from '../contracts/chat.js';

export const oldArtifactsProjector: ProjectorSpec<null> = {
  eventTypes: [
    'artifacts.created/v1',
    'artifacts.revised/v1',
    'artifacts.applied/v1',
    'artifacts.approved/v1',
  ],
  initial: () => null,
  reduce: (state) => ({ state, blocks: [] }),
};
