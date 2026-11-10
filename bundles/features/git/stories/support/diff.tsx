// Where a comparison lives: a workspace tab beside the conversation, on the
// viewer's inset card over the window's sidebar-coloured canvas, with the diff
// editor's controls as the editor hands them to its toolbar and footer.

import type { DiffControls } from 'desktop/ui/code';
import { TooltipProvider } from 'desktop/ui/tooltip';
import type { ComponentType } from 'react';

export const tabDecorators = [
  (Story: ComponentType) => (
    <TooltipProvider>
      <div className="flex max-w-4xl flex-col bg-sidebar p-2">
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl bg-background p-2 shadow-sm">
          <Story />
        </div>
      </div>
    </TooltipProvider>
  ),
];

/** A full comparison tab: the editor needs a height to fill. */
export const fullTabDecorators = [
  (Story: ComponentType) => (
    <div className="flex h-[36rem] max-w-5xl flex-col bg-sidebar p-2">
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl bg-background p-2 shadow-sm">
        <Story />
      </div>
    </div>
  ),
];

export const controls = (
  overrides: Partial<DiffControls> = {},
): DiffControls => ({
  counts: { added: 14, removed: 9 },
  layout: 'unified',
  onLayout: () => undefined,
  onNavigate: () => undefined,
  ...overrides,
});
