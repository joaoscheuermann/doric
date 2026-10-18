// Where the Changes view lives: the Project panel beside the conversation,
// a sidebar-coloured column about as wide as the panel opens.

import type { ComponentType } from 'react';

export const panelDecorators = [
  (Story: ComponentType) => (
    <div className="flex h-[32rem] w-80 flex-col overflow-hidden rounded-md border bg-sidebar text-sidebar-foreground">
      <Story />
    </div>
  ),
];
