// Where the Changes view lives: the Project panel beside the conversation,
// a sidebar-coloured column about as wide as the panel opens, drawn on the
// window's canvas without a frame of its own.

import type { ComponentType } from 'react';

export const panelDecorators = [
  (Story: ComponentType) => (
    <div className="flex h-[32rem] w-80 flex-col overflow-hidden bg-sidebar text-sidebar-foreground">
      <Story />
    </div>
  ),
];
