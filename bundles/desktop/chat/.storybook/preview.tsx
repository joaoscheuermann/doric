// The preview harness the papercraft previews (and Storybook) wrap every
// story of this bundle in: Storybook's `Preview` shape, a default export
// with `decorators`. The sheets are the window's: the platform theme the
// window loads once, then the chat's own rules over it. The decorator puts
// the story on the conversation's background at the width the chat column
// draws.

import 'desktop/ui/theme.css';
import '../src/client/styles.css';

import { PortalContainerProvider } from 'desktop/ui/portal-container';
import type { ComponentType } from 'react';

const decorators = [
  (Story: ComponentType) => (
    <div className="bg-background p-6 text-foreground">
      <div className="mx-auto max-w-3xl">
        <Story />
      </div>
    </div>
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
