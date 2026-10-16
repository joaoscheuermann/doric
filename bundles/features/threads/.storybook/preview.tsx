// The preview harness the papercraft previews (and Storybook) wrap every
// story of this bundle in: Storybook's `Preview` shape, a default export
// with `decorators`. The sheets are the window's: the platform theme the
// window loads once, then the threads bundle's own utilities over it. The
// decorator puts the story on the conversation's background at the width
// the chat column draws, where chat hosts a delegated turn.

import 'desktop/ui/theme.css';
import '../src/client/styles.css';

import type { ComponentType } from 'react';

const decorators = [
  (Story: ComponentType) => (
    <div className="bg-background p-6 text-foreground">
      <div className="mx-auto max-w-3xl">
        <Story />
      </div>
    </div>
  ),
];

export default { decorators };
