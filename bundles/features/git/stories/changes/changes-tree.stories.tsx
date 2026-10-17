import { SidebarMenu, SidebarScope } from 'desktop/ui/sidebar';
import { TooltipProvider } from 'desktop/ui/tooltip';
import { type ComponentType, useState } from 'react';

import { ChangesTree } from '../../src/client/changes/changes-tree.js';
import { changeDirectoryKey } from '../../src/client/reads/change-tree.js';
import {
  manyChanges,
  tokensRepository,
  workspaceRepository,
} from '../support/fixtures.js';
import { panelDecorators } from '../support/panel.js';

type Repository = Parameters<typeof ChangesTree>[0]['repository'];

/** The tree with its own collapsed state, so rows toggle and select. */
function Tree({
  repository,
  collapsed: initial = [],
  selectedPath: initialPath,
}: {
  readonly repository: Repository;
  readonly collapsed?: readonly string[];
  readonly selectedPath?: string;
}) {
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(
    () => new Set(initial),
  );
  const [selectedPath, setSelectedPath] = useState(initialPath);
  return (
    <SidebarMenu role="tree" className="w-full gap-0 py-1">
      <ChangesTree
        repository={repository}
        collapsed={collapsed}
        selectedPath={selectedPath}
        onToggle={(key) =>
          setCollapsed((current) => {
            const next = new Set(current);
            if (!next.delete(key)) next.add(key);
            return next;
          })
        }
        onOpen={(path, change) =>
          setSelectedPath(path === '' ? change.path : `${path}/${change.path}`)
        }
      />
    </SidebarMenu>
  );
}

const decorators = [
  (Story: ComponentType) => (
    <TooltipProvider>
      <SidebarScope>
        <Story />
      </SidebarScope>
    </TooltipProvider>
  ),
  ...panelDecorators,
];

export default {
  title: 'Git/Changes/Changes tree',
  component: ChangesTree,
  decorators,
};

export const Workspace = {
  render: () => <Tree repository={workspaceRepository} />,
};

export const SelectedComparison = {
  render: () => (
    <Tree
      repository={workspaceRepository}
      selectedPath="src/components/Checkout.tsx"
    />
  ),
};

export const NestedRepositoryWithConflict = {
  render: () => <Tree repository={tokensRepository} />,
};

export const CollapsedDirectory = {
  render: () => (
    <Tree
      repository={workspaceRepository}
      collapsed={[changeDirectoryKey('', 'src/lib')]}
    />
  ),
};

export const CollapsedRepository = {
  render: () => (
    <Tree
      repository={workspaceRepository}
      collapsed={[changeDirectoryKey('', '')]}
    />
  ),
};

export const ManyFiles = {
  render: () => <Tree repository={manyChanges.repositories[0] as Repository} />,
};

export const LongRepositoryPath = {
  render: () => (
    <Tree
      repository={{
        ...tokensRepository,
        path: 'packages/design-tokens/vendor/upstream-material-theme-builder',
      }}
    />
  ),
};
