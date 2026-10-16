// The preview harness the papercraft previews (and Storybook) wrap every
// story of this bundle in: Storybook's `Preview` shape, a default export
// with `decorators`. The sheets are the window's: the platform theme the
// window loads once, then the bundle's own utilities over it. The monitor
// lives in the window's global footer, so the decorator draws that bar at
// the bottom of the surface, with room above it for the popovers that open
// upward, under the tooltip provider every control needs.

import 'desktop/ui/theme.css';
import '../src/client/styles.css';

import { TooltipProvider } from 'desktop/ui/tooltip';
import type { ComponentType } from 'react';

const decorators = [
  (Story: ComponentType) => (
    <TooltipProvider>
      <div className="flex min-h-80 flex-col justify-end bg-background p-6 text-foreground">
        <footer className="flex h-8 shrink-0 items-center justify-end gap-1.5 border-t bg-sidebar px-2 text-xs text-muted-foreground">
          <span className="px-1">Connected</span>
          <Story />
        </footer>
      </div>
    </TooltipProvider>
  ),
];

export default { decorators };
