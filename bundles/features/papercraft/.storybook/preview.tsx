// The preview harness the papercraft previews (and Storybook) wrap every
// story of this bundle in: Storybook's `Preview` shape, a default export
// with `decorators`. The sheets are the window's: the platform theme the
// window loads once, then papercraft's own rules over it (the pins, the
// thread and the tree). The decorator only puts the story on the window's
// background: each story file draws the box its part lives in — the node's
// square in the conversation column, the canvas window, or a bare canvas.

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
