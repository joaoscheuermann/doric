import {
  indentation,
  rowInteraction,
  treeClassName,
  TreeGuides,
} from '@/components/molecules/tree-guides';
import {
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSkeleton,
  SidebarMenuSub,
  SidebarMenuSubItem,
} from '@/components/ui/sidebar';
import { emptyDirectoryNotice } from '@/domain/files';
import type { ProjectFileEntry } from '@/domain/workspace';
import { cn } from '@/utility/utils';
import { ChevronRightIcon, FileIcon, FolderIcon } from 'lucide-react';

export type FileTreeActions = {
  readonly open: (path: string) => void;
  readonly toggle: (path: string) => void;
};

type FileTreeProps = {
  readonly actions: FileTreeActions;
  readonly depth: number;
  readonly entries: readonly ProjectFileEntry[];
  readonly expanded: ReadonlySet<string>;
  readonly listings: Readonly<Record<string, readonly ProjectFileEntry[]>>;
  readonly loading: ReadonlySet<string>;
  readonly selectedPath?: string;
};

/**
 * One level of a Project's sandbox, recursing into the directories that are
 * open. It reads nothing itself: the entries, what is expanded, the listings
 * already held and the row actions all arrive through props.
 *
 * A directory is a row that expands — on click, Enter, Space or ArrowRight —
 * and collapses on ArrowLeft; a file is a row that selects. A directory the
 * user has never opened, and that is not being read, renders no children at
 * all, which is what makes expansion lazy.
 */
export function FileTree({
  actions,
  depth,
  entries,
  expanded,
  listings,
  loading,
  selectedPath,
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
        const children = directory ? listings[entry.path] : undefined;

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
                  'h-7 w-full rounded-none pr-8 [&>svg]:size-3.5!',
                  rowInteraction(selected),
                )}
                style={{ paddingLeft: indentation(depth) }}
              >
                <div
                  role="treeitem"
                  tabIndex={0}
                  aria-expanded={directory ? open : undefined}
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
                  <span>{entry.name}</span>
                </div>
              </SidebarMenuButton>
            </div>
            {open && (
              <SidebarMenuSub role="group" className={treeClassName}>
                {children === undefined && loading.has(entry.path) && (
                  <SidebarMenuSubItem role="presentation" className="w-full">
                    <SidebarMenuSkeleton className="w-full" />
                  </SidebarMenuSubItem>
                )}
                {children !== undefined && children.length === 0 && (
                  <SidebarMenuSubItem
                    role="presentation"
                    className="w-full py-1 text-xs text-muted-foreground"
                    style={{ paddingLeft: indentation(depth + 1) }}
                  >
                    {emptyDirectoryNotice}
                  </SidebarMenuSubItem>
                )}
                {children !== undefined && children.length > 0 && (
                  <FileTree
                    actions={actions}
                    depth={depth + 1}
                    entries={children}
                    expanded={expanded}
                    listings={listings}
                    loading={loading}
                    selectedPath={selectedPath}
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
