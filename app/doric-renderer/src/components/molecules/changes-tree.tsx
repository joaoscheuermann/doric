import { ChangeCounts } from '@/components/molecules/change-counts';
import { FileTree } from '@/components/molecules/file-tree';
import {
  indentation,
  rowInteraction,
  treeClassName,
} from '@/components/molecules/tree-guides';
import { Badge } from '@/components/ui/badge';
import {
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
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

/**
 * One repository and its changed paths, drawn as the same tree row Files uses:
 * the repository is a row at depth 0 that expands like a directory, and its
 * changed paths are the same `FileTree` rows nested under it. The branch icon
 * and the repository's line totals are that row's own content, not a second
 * header shape.
 */
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
  const label = repository.path || 'workspace';
  return (
    <SidebarMenuItem role="presentation" className="w-full">
      <div className="group/tree-row relative w-full">
        <SidebarMenuButton
          asChild
          size="sm"
          className={cn('h-7 w-full rounded-none pr-8', rowInteraction(false))}
          style={{ paddingLeft: indentation(0) }}
        >
          <div
            role="treeitem"
            tabIndex={0}
            aria-expanded={open}
            aria-label={`${label}, ${repository.added} lines added, ${repository.removed} lines removed`}
            title={repository.path || 'Workspace repository'}
            onClick={() => onToggle(key)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                onToggle(key);
              } else if (event.key === 'ArrowRight' && !open) {
                event.preventDefault();
                onToggle(key);
              } else if (event.key === 'ArrowLeft' && open) {
                event.preventDefault();
                onToggle(key);
              }
            }}
          >
            <ChevronRightIcon
              aria-hidden
              className={cn(
                'transition-transform duration-[50ms] ease-out',
                open ? 'rotate-90' : 'rotate-0',
              )}
            />
            <GitBranchIcon />
            <span className="truncate font-light">{label}</span>
          </div>
        </SidebarMenuButton>
        <SidebarMenuBadge>
          <Badge variant="ghost" className="px-1" aria-hidden>
            <ChangeCounts
              added={repository.added}
              removed={repository.removed}
            />
          </Badge>
        </SidebarMenuBadge>
      </div>
      {open && (
        <SidebarMenuSub role="group" className={treeClassName}>
          <FileTree
            entries={entries}
            depth={1}
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
        </SidebarMenuSub>
      )}
    </SidebarMenuItem>
  );
}
