// The preview harness the papercraft previews (and Storybook) wrap every
// story of this package in: Storybook's `Preview` shape, a default export
// with `decorators`. The sheet is the package's own theme, the one the window
// loads. The decorator puts the story on the window's background, as the app
// draws it, under the one `TooltipProvider` a window mounts (the tooltip,
// sidebar and toolbar stories need it).

import '../src/styles/theme.css';

import { PortalContainerProvider } from 'desktop/ui/portal-container';
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
  // The preview hands the harness its portal container: `desktop/ui`'s
  // overlays portal into it and stay inside the preview. Storybook, which
  // hands none, keeps their default.
  (
    Story: ComponentType,
    context: {
      readonly papercraft?: { readonly portalContainer?: HTMLElement };
    },
  ) => (
    <PortalContainerProvider container={context.papercraft?.portalContainer}>
      <Story />
    </PortalContainerProvider>
  ),
];

export default { decorators };
