// The preview harness the papercraft previews (and Storybook) wrap every
// story of this bundle in: Storybook's `Preview` shape, a default export
// with `decorators`. The sheets are the settings window's: the platform theme
// the window loads once, then the settings bundle's own utilities over it.
// The decorator only puts the story on the window's background; each story
// file frames itself where its component lives (the conversation footer, a
// section's content column, or the whole window) through the frames in
// `stories/support/frames.tsx`, because one bundle draws all three.

import 'desktop/ui/theme.css';
import '../src/client/styles.css';

import type { ComponentType } from 'react';

const decorators = [
  (Story: ComponentType) => (
    <div className="min-h-svh bg-background text-foreground">
      <Story />
    </div>
  ),
];

export default { decorators };
