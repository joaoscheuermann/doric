// The preview harness the papercraft previews (and Storybook) wrap every
// story of this bundle in: Storybook's `Preview` shape, a default export
// with `decorators`. The sheets are the window's: the platform theme the
// window loads once, then the bundle's own utilities over it. The decorator
// puts the story on the window's background, under the tooltip provider
// every usage control needs; the footer stories add the conversation's bar
// themselves (`stories/support/footer.tsx`).

import 'desktop/ui/theme.css';
import '../src/client/styles.css';

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
