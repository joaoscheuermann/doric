import {
  indentation,
  rowInteraction,
  TreeGuides,
  treeClassName,
} from 'desktop/ui/panels';
import { FileIcon, FolderIcon } from 'lucide-react';

import { PanelFrame } from '../support/sidebar-frame.js';

export default {
  title: 'desktop/ui/Panels/Tree guides',
  component: TreeGuides,
};

const rows = [
  { path: 'packages', depth: 0, folder: true },
  { path: 'desktop', depth: 1, folder: true },
  { path: 'src', depth: 2, folder: true },
  { path: 'panels', depth: 3, folder: true },
  { path: 'tree-guides.tsx', depth: 4, folder: false },
  { path: 'file-tree.tsx', depth: 4, folder: false },
  { path: 'index.ts', depth: 3, folder: false },
  { path: 'package.json', depth: 1, folder: false },
];

export const Depths = {
  render: () => (
    <PanelFrame>
      <div className={treeClassName}>
        {rows.map((row) => (
          <div
            key={`${row.depth}-${row.path}`}
            className={`relative flex h-7 items-center gap-2 pr-8 text-sm ${rowInteraction(row.path === 'tree-guides.tsx')}`}
            style={{ paddingLeft: indentation(row.depth) }}
          >
            <TreeGuides depth={row.depth} />
            {row.folder ? (
              <FolderIcon className="size-4" />
            ) : (
              <FileIcon className="size-4" />
            )}
            <span className="truncate font-light">{row.path}</span>
          </div>
        ))}
      </div>
    </PanelFrame>
  ),
};
