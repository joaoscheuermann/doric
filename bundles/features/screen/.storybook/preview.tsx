// The preview harness the papercraft previews (and Storybook) wrap every
// story of this bundle in: Storybook's `Preview` shape, a default export
// with `decorators`. The bundle has no client stylesheet of its own, so the
// sheet is the platform theme the window loads once. The decorator puts the
// story on the sidebar's background at the sidebar's width, where the
// layout draws the Screens pane.

import 'desktop/ui/theme.css';

import type { ComponentType } from 'react';

const decorators = [
  (Story: ComponentType) => (
    <div className="bg-background p-6 text-foreground">
      <div className="w-64 rounded-md border border-sidebar-border bg-sidebar py-1 text-sidebar-foreground">
        <Story />
      </div>
    </div>
  ),
];

export default { decorators };
