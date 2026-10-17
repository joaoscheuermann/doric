import type { ComponentType } from 'react';

import { ItemContextMenu } from '../../../src/client/components/molecules/item-context-menu.js';
import { ProjectAvatar } from '../../../src/client/components/molecules/project-avatar.js';
import { OpenContextMenu } from '../../support/open-context-menu.js';

const ignore = () => undefined;

/** The row the menu wraps; the trigger needs a DOM element to listen on. */
const row =
  'flex h-7 w-60 items-center gap-2 bg-sidebar px-3 text-xs text-sidebar-foreground';

export default {
  title: 'Layout/Molecules/Item context menu',
  component: ItemContextMenu,
  decorators: [
    (Story: ComponentType) => (
      <div className="h-64">
        <Story />
      </div>
    ),
  ],
};

/** A Thread row's menu, open: add a child, copy the ID, delete. */
export const ThreadMenu = {
  render: () => (
    <OpenContextMenu>
      <ItemContextMenu
        addLabel="New child thread"
        deleteLabel="Delete thread"
        onAdd={ignore}
        onCopyId={ignore}
        onDelete={ignore}
      >
        <div className={row}>Build the payment form</div>
      </ItemContextMenu>
    </OpenContextMenu>
  ),
};

/** A Project row's menu, open, with its color section. */
export const ProjectMenu = {
  render: () => (
    <OpenContextMenu>
      <ItemContextMenu
        addLabel="New thread"
        color={{ value: 'violet', onSelect: ignore }}
        deleteLabel="Delete project"
        onAdd={ignore}
        onDelete={ignore}
      >
        <div className={row}>
          <ProjectAvatar color="violet" />
          Checkout redesign
        </div>
      </ItemContextMenu>
    </OpenContextMenu>
  ),
};

/** Closed: right-click the row to open it. */
export const Closed = {
  render: () => (
    <ItemContextMenu
      addLabel="New child thread"
      deleteLabel="Delete thread"
      onAdd={ignore}
      onCopyId={ignore}
      onDelete={ignore}
    >
      <div className={row}>Review error copy</div>
    </ItemContextMenu>
  ),
};
