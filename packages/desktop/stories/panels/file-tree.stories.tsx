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
  loading,
}: {
  readonly entries?: readonly TreeNode[];
  readonly open?: readonly string[];
  readonly selected?: string;
  readonly decorations?: ReadonlyMap<string, TreeDecoration>;
  readonly loading?: ReadonlySet<string>;
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
        loading={loading}
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

export const Loading = {
  render: () => (
    <Tree
      open={['packages', 'packages/desktop']}
      loading={new Set(['packages/desktop'])}
    />
  ),
};

/** Ten directories of 5,000 files each, all open: only a screenful is drawn. */
const thousands: readonly TreeNode[] = Array.from(
  { length: 10 },
  (_, folder) => {
    const path = `folder-${folder}`;
    return {
      name: path,
      path,
      type: 'directory' as const,
      children: Array.from({ length: 5_000 }, (_, index) => ({
        name: `file-${String(index).padStart(4, '0')}.ts`,
        path: `${path}/file-${String(index).padStart(4, '0')}.ts`,
        type: 'file' as const,
      })),
    };
  },
);

export const FiftyThousandRows = {
  render: () => (
    <Tree
      entries={thousands}
      open={thousands.map((entry) => entry.path)}
      selected="folder-0/file-0002.ts"
    />
  ),
};
