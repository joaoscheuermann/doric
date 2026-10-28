// The preview harness the papercraft previews (and Storybook) wrap every
// story of this bundle in: Storybook's `Preview` shape, a default export
// with `decorators`. The bundle has no client stylesheet of its own, so the
// sheet is the platform theme the window loads once. Each story file frames
// its own stories: the pane at the sidebar's width, the dialogs at the
// window's.

import 'desktop/ui/theme.css';

import type { ComponentType } from 'react';

const decorators = [
  (Story: ComponentType) => (
    <div className="bg-background p-6 text-foreground">
      <Story />
    </div>
  ),
];

export default { decorators };
