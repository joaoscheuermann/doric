// The preview harness the papercraft previews (and Storybook) wrap every
// story of this bundle in: Storybook's `Preview` shape, a default export
// with `decorators`. The bundle has no client stylesheet of its own — its
// elements style their shadow trees — so the window's platform theme is the
// only sheet. The decorator puts the story on the conversation's background
// at the width the chat column draws, where the registry's frame lives.

import 'desktop/ui/theme.css';

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
