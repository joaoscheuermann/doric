// The preview harness the papercraft previews (and Storybook) wrap every
// story of this bundle in: Storybook's `Preview` shape, a default export
// with `decorators`. The sheets are the window's: the platform theme the
// window loads once, then the terminal bundle's utilities and scrollbar
// rules over it. The decorator only puts the story on the window's
// background; each story file gives its component the frame it has in the
// app (a sidebar Thread, a workspace tab, the bottom split).

import 'desktop/ui/theme.css';
import '../src/client/styles.css';

import type { ComponentType } from 'react';

const decorators = [
  (Story: ComponentType) => (
    <div className="bg-background p-6 text-foreground">
      <Story />
    </div>
  ),
];

export default { decorators };
