// The projector of `openui.answered/v1` rows (conversation-openui.md D22,
// D29): it claims the type and draws nothing, so the chat never shows a
// generic block for an answer, also while the setting is off.

import type { ProjectorSpec } from './chat-contract.js';

export const answersProjector: ProjectorSpec<null> = {
  eventTypes: ['openui.answered/v1'],
  initial: () => null,
  reduce: (state) => ({ state, blocks: [] }),
};
