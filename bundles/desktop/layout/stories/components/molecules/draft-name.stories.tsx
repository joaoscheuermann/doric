import type { ComponentType } from 'react';

import { DraftName } from '../../../src/client/components/molecules/draft-name.js';

const settle = () => Promise.resolve();
const ignore = () => undefined;

export default {
  title: 'Layout/Molecules/Draft name',
  component: DraftName,
  decorators: [
    (Story: ComponentType) => (
      <div className="w-60 bg-sidebar py-2 text-sidebar-foreground">
        <Story />
      </div>
    ),
  ],
};

/** A Thread being created at the root of the tree. */
export const Thread = {
  render: () => (
    <DraftName
      depth={0}
      label="New thread name"
      onCancel={ignore}
      onSubmit={settle}
    />
  ),
};

/** A child Thread two levels deep, with its tree guides. */
export const NestedThread = {
  render: () => (
    <DraftName
      depth={2}
      label="New thread name"
      onCancel={ignore}
      onSubmit={settle}
    />
  ),
};

/** A Project being created: the hollow color mark, no indentation. */
export const Project = {
  render: () => (
    <DraftName label="New project name" onCancel={ignore} onSubmit={settle} />
  ),
};
