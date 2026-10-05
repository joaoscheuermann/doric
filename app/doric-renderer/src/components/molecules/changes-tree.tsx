import { ChangeCounts } from '@/components/molecules/change-counts';
import { FileTree } from '@/components/molecules/file-tree';
import {
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from '@/components/ui/sidebar';
import {
  changeDirectoryKey,
  type ChangeRepository,
  changesTreeView,
} from '@/domain/change-tree';
import type { ProjectChange } from '@/domain/workspace';
import { cn } from '@/utility/utils';
import { ChevronRightIcon, GitBranchIcon } from 'lucide-react';

type ChangesTreeProps = {
  readonly repository: ChangeRepository & {
    readonly added: number;
    readonly removed: number;
  };
  readonly collapsed: ReadonlySet<string>;
  readonly selectedPath?: string;
  readonly onToggle: (key: string) => void;
  readonly onOpen: (repository: string, change: ProjectChange) => void;
};

/** One repository and its changed paths, using the same rows as Files. */
export function ChangesTree({
  repository,
  collapsed,
  selectedPath,
  onToggle,
  onOpen,
}: ChangesTreeProps) {
  const { entries, key, open, expanded, decorations, changes } =
    changesTreeView(repository, '', collapsed);
  if (entries.length === 0) return null;
  return (
    <section
      className="flex min-w-0 flex-col"
      aria-label={`Changes in ${repository.path || 'workspace'}`}
    >
      <SidebarMenu className="gap-0">
        <SidebarMenuItem>
          <SidebarMenuButton
            size="sm"
            className="h-8 rounded-none px-2"
            aria-expanded={open}
            onClick={() => onToggle(key)}
            title={repository.path || 'Workspace repository'}
          >
            <ChevronRightIcon
              className={cn('transition-transform', open && 'rotate-90')}
            />
            <GitBranchIcon />
            <span className="truncate">{repository.path || 'workspace'}</span>
            <span className="ml-auto">
              <ChangeCounts
                added={repository.added}
                removed={repository.removed}
              />
            </span>
          </SidebarMenuButton>
        </SidebarMenuItem>
      </SidebarMenu>
      {open && (
        <SidebarMenu
          role="tree"
          aria-label={`Changed files in ${repository.path || 'workspace'}`}
          className="gap-0 pb-2"
        >
          <FileTree
            entries={entries}
            depth={0}
            expanded={expanded}
            decorations={decorations}
            selectedPath={selectedPath}
            actions={{
              toggle: (path) =>
                onToggle(changeDirectoryKey(repository.path, path)),
              open: (path) => {
                const change = changes.get(path);
                if (change !== undefined) onOpen(repository.path, change);
              },
            }}
          />
        </SidebarMenu>
      )}
    </section>
  );
}
