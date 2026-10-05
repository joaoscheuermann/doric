import {
  indentation,
  rowInteraction,
  treeClassName,
  TreeGuides,
} from '@/components/molecules/tree-guides';
import { Badge } from '@/components/ui/badge';
import {
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubItem,
} from '@/components/ui/sidebar';
import { changeClassName, type ChangeDecoration } from '@/domain/change-tree';
import { changeLetter, emptyDirectoryNotice } from '@/domain/files';
import type { ProjectTreeNode } from '@/domain/workspace';
import { cn } from '@/utility/utils';
import { ChevronRightIcon, FileIcon, FolderIcon } from 'lucide-react';

export type FileTreeActions = {
  readonly open: (path: string) => void;
  readonly toggle: (path: string) => void;
};

type FileTreeProps = {
  readonly actions: FileTreeActions;
  readonly depth: number;
  readonly entries: readonly ProjectTreeNode[];
  readonly expanded: ReadonlySet<string>;
  readonly selectedPath?: string;
  readonly decorations?: ReadonlyMap<string, ChangeDecoration>;
};

/**
 * One level of a Project's sandbox, recursing into the directories that are
 * open. The whole tree arrives through `entries`, so this reads nothing and
 * asks for nothing: expanding a directory only decides what is drawn.
 *
 * A directory is a row that expands — on click, Enter, Space or ArrowRight —
 * and collapses on ArrowLeft; a file is a row that selects. A directory that is
 * not expanded renders no children at all.
 */
export function FileTree({
  actions,
  depth,
  entries,
  expanded,
  selectedPath,
  decorations,
}: FileTreeProps) {
  return (
    <>
      {entries.map((entry) => {
        const directory = entry.type === 'directory';
        const open = directory && expanded.has(entry.path);
        const selected = !directory && selectedPath === entry.path;
        const activate = (): void => {
          if (directory) actions.toggle(entry.path);
          else actions.open(entry.path);
        };
        const children = directory ? (entry.children ?? []) : [];
        const decoration = decorations?.get(entry.path);

        return (
          <SidebarMenuItem
            key={entry.path}
            role="presentation"
            className="w-full"
          >
            <div className="group/tree-row relative w-full">
              <TreeGuides depth={depth} />
              <SidebarMenuButton
                asChild
                isActive={selected}
                size="sm"
                className={cn(
                  'h-7 w-full rounded-none pr-8',
                  rowInteraction(selected),
                )}
                style={{ paddingLeft: indentation(depth) }}
              >
                <div
                  role="treeitem"
                  tabIndex={0}
                  aria-expanded={directory ? open : undefined}
                  aria-selected={selected}
                  aria-label={
                    decoration === undefined
                      ? entry.name
                      : `${entry.name}, ${decoration.description}`
                  }
                  title={
                    decoration === undefined
                      ? entry.path
                      : `${entry.path}\n${decoration.description}`
                  }
                  onClick={activate}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault();
                      activate();
                    } else if (
                      event.key === 'ArrowRight' &&
                      directory &&
                      !open
                    ) {
                      event.preventDefault();
                      actions.toggle(entry.path);
                    } else if (event.key === 'ArrowLeft' && open) {
                      event.preventDefault();
                      actions.toggle(entry.path);
                    }
                  }}
                >
                  {directory && (
                    <ChevronRightIcon
                      aria-hidden
                      className={cn(
                        'transition-transform duration-[50ms] ease-out',
                        open ? 'rotate-90' : 'rotate-0',
                      )}
                    />
                  )}
                  {directory ? <FolderIcon /> : <FileIcon />}
                  <span
                    className={cn(
                      'truncate',
                      decoration?.status !== undefined &&
                        changeClassName(decoration.status),
                      decoration?.status !== undefined
                        ? 'font-normal'
                        : 'font-light',
                      !directory &&
                        decoration?.status === 'deleted' &&
                        'line-through',
                    )}
                  >
                    {entry.name}
                  </span>
                </div>
              </SidebarMenuButton>
              {decoration !== undefined && (
                <SidebarMenuBadge>
                  <Badge variant="ghost" className="px-1" aria-hidden>
                    <span
                      className={
                        decoration.status === undefined
                          ? undefined
                          : changeClassName(decoration.status)
                      }
                    >
                      {directory
                        ? decoration.count
                        : decoration.status === undefined
                          ? ''
                          : changeLetter(decoration.status)}
                    </span>
                  </Badge>
                </SidebarMenuBadge>
              )}
            </div>
            {open && (
              <SidebarMenuSub role="group" className={treeClassName}>
                {children.length === 0 ? (
                  <SidebarMenuSubItem
                    role="presentation"
                    className="w-full py-1 text-xs text-muted-foreground"
                    style={{ paddingLeft: indentation(depth + 1) }}
                  >
                    {emptyDirectoryNotice}
                  </SidebarMenuSubItem>
                ) : (
                  <FileTree
                    actions={actions}
                    depth={depth + 1}
                    entries={children}
                    expanded={expanded}
                    selectedPath={selectedPath}
                    decorations={decorations}
                  />
                )}
              </SidebarMenuSub>
            )}
          </SidebarMenuItem>
        );
      })}
    </>
  );
}
