import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuTrigger,
} from 'desktop/ui/context-menu';
import { type ComponentType, useState } from 'react';

import { ProjectAvatar } from '../../../src/client/components/molecules/project-avatar.js';
import { ProjectColorMenu } from '../../../src/client/components/molecules/project-color-menu.js';
import type { ProjectColor } from '../../../src/client/domain/workspace.js';
import { OpenContextMenu } from '../../support/open-context-menu.js';

/** A Project row whose menu holds only the color submenu; picks apply. */
function ColorRow({ initial }: { readonly initial?: ProjectColor }) {
  const [color, setColor] = useState(initial);
  return (
    <OpenContextMenu>
      <ContextMenu>
        <ContextMenuTrigger
          render={
            <div className="flex h-7 w-60 items-center gap-2 bg-sidebar px-3 text-xs text-sidebar-foreground" />
          }
        >
          <ProjectAvatar color={color} />
          Checkout redesign
        </ContextMenuTrigger>
        <ContextMenuContent>
          <ProjectColorMenu value={color} onSelect={setColor} />
        </ContextMenuContent>
      </ContextMenu>
    </OpenContextMenu>
  );
}

export default {
  title: 'Layout/Molecules/Project color menu',
  component: ProjectColorMenu,
  decorators: [
    (Story: ComponentType) => (
      <div className="h-80">
        <Story />
      </div>
    ),
  ],
};

/** The menu open on a colored Project; hover "Color" for the palette. */
export const Colored = {
  render: () => <ColorRow initial="violet" />,
};

/** A Project with no color: "No color" is the checked item. */
export const NoColor = {
  render: () => <ColorRow />,
};
