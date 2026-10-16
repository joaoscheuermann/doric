import {
  FileTree,
  type TreeDecoration,
  type TreeNode,
  toggleExpanded,
} from 'desktop/ui/panels';
import { useState } from 'react';

import { fileTree } from '../support/doric.js';
import { PanelFrame } from '../support/sidebar-frame.js';

export default {
  title: 'desktop/ui/Panels/File tree',
  component: FileTree,
};

const added = 'text-[oklch(0.6_0.15_150)]';
const modified = 'text-[oklch(0.68_0.15_70)]';
const deleted = 'text-[oklch(0.6_0.19_27)]';

const changes: ReadonlyMap<string, TreeDecoration> = new Map([
  ['packages', { description: '3 changes', count: 3, tone: modified }],
  ['packages/desktop', { description: '3 changes', count: 3, tone: modified }],
  [
    'packages/desktop/src',
    { description: '2 changes', count: 2, tone: modified },
  ],
  [
    'packages/desktop/src/components',
    { description: '1 change', count: 1, tone: added },
  ],
  [
    'packages/desktop/src/components/tabs.tsx',
    { description: 'Added', count: 1, tone: added, letter: 'A' },
  ],
  [
    'packages/desktop/src/chrome-bar.tsx',
    { description: 'Modified', count: 1, tone: modified, letter: 'M' },
  ],
  [
    'packages/desktop/package.json',
    {
      description: 'Deleted',
      count: 1,
      tone: deleted,
      letter: 'D',
      struck: true,
    },
  ],
]);

const Tree = ({
  entries = fileTree,
  open = [],
  selected,
  decorations,
}: {
  readonly entries?: readonly TreeNode[];
  readonly open?: readonly string[];
  readonly selected?: string;
  readonly decorations?: ReadonlyMap<string, TreeDecoration>;
}) => {
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(
    () => new Set(open),
  );
  const [selectedPath, setSelectedPath] = useState(selected);
  return (
    <PanelFrame tree>
      <FileTree
        actions={{
          open: setSelectedPath,
          toggle: (path) =>
            setExpanded((current) => toggleExpanded(current, path)),
        }}
        depth={0}
        entries={entries}
        expanded={expanded}
        selectedPath={selectedPath}
        decorations={decorations}
      />
    </PanelFrame>
  );
};

const deep = [
  'packages',
  'packages/desktop',
  'packages/desktop/src',
  'packages/desktop/src/components',
];

export const Default = {
  render: () => (
    <Tree open={deep} selected="packages/desktop/src/components/sidebar.tsx" />
  ),
};

export const Collapsed = {
  render: () => <Tree />,
};

export const WithChanges = {
  render: () => (
    <Tree
      open={deep}
      selected="packages/desktop/src/chrome-bar.tsx"
      decorations={changes}
    />
  ),
};

export const EmptyDirectory = {
  render: () => (
    <Tree open={['bundles', 'bundles/desktop', 'bundles/desktop/layout']} />
  ),
};

export const LongNames = {
  render: () => (
    <Tree
      entries={[
        {
          name: 'a-very-long-directory-name-that-overflows-the-panel',
          path: 'long',
          type: 'directory',
          children: [
            {
              name: 'comment-thread-popover-with-replies-and-resolve.stories.tsx',
              path: 'long/comment-thread-popover-with-replies-and-resolve.stories.tsx',
              type: 'file',
            },
          ],
        },
      ]}
      open={['long']}
      selected="long/comment-thread-popover-with-replies-and-resolve.stories.tsx"
    />
  ),
};
