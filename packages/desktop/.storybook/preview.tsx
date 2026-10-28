// The preview harness the papercraft previews (and Storybook) wrap every
// story of this package in: Storybook's `Preview` shape, a default export
// with `decorators`. The sheet is the package's own theme, the one the window
// loads. The decorator puts the story on the window's background, as the app
// draws it, under the one `TooltipProvider` a window mounts (the tooltip,
// sidebar and toolbar stories need it).

import '../src/styles/theme.css';

import { TooltipProvider } from 'desktop/ui/tooltip';
import type { ComponentType } from 'react';

const decorators = [
  (Story: ComponentType) => (
    <TooltipProvider>
      <div className="bg-background p-6 text-foreground">
        <Story />
      </div>
    </TooltipProvider>
  ),
];

export default { decorators };
