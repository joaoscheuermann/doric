import { Badge } from 'desktop/ui/badge';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from 'desktop/ui/context-menu';
import {
  FileTree,
  indentation,
  type TreeNode,
  treeClassName,
} from 'desktop/ui/panels';
import {
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
} from 'desktop/ui/sidebar';
import { cn } from 'desktop/ui/utils';
import { GitBranchIcon, RotateCcwIcon } from 'lucide-react';
import { memo, type ReactNode, useMemo } from 'react';

import type { ProjectChange } from '../../contracts/index.js';
import {
  type ChangeRepository,
  changeDirectoryKey,
  changesTreeView,
} from '../reads/change-tree.js';
import { ChangeCounts } from './change-counts.js';
import type { DiscardTarget } from './discard-dialog.js';

/**
 * The repository row's fill, on its wrapper: the row is never selected, so it
 * mixes the accent in at 50% under the pointer and 80% while pressed
 * (docs/designs/sidebar-alignment.md §11.1).
 */
const rowFill =
  'rounded-[4px] hover:bg-[color-mix(in_oklch,var(--sidebar-accent)_50%,var(--sidebar))] active:bg-[color-mix(in_oklch,var(--sidebar-accent)_80%,var(--sidebar))]';

/** The row ring, inset on the wrapper while its treeitem has keyboard focus. */
const treeitemRing =
  'has-[[role=treeitem]:focus-visible]:ring-2 has-[[role=treeitem]:focus-visible]:ring-inset has-[[role=treeitem]:focus-visible]:ring-sidebar-ring';

/** A row button that draws no fill and no ring: its wrapper draws both. */
const noFillButton =
  'bg-transparent hover:bg-transparent active:bg-transparent data-active:bg-transparent focus-visible:ring-0';

/** The pinned mark's backing: opaque, and the row's fill in each state (§11.2). */
const markBacking =
  'bg-sidebar group-hover/tree-row:bg-[color-mix(in_oklch,var(--sidebar-accent)_50%,var(--sidebar))] group-active/tree-row:bg-[color-mix(in_oklch,var(--sidebar-accent)_80%,var(--sidebar))]';

type ChangesTreeProps = {
  readonly repository: ChangeRepository & {
    readonly added: number;
    readonly removed: number;
  };
  readonly collapsed: ReadonlySet<string>;
  readonly selectedPath?: string;
  readonly onToggle: (key: string) => void;
  readonly onOpen: (repository: string, change: ProjectChange) => void;
  /**
   * Asks to discard a target (A11, A12): the file rows' and the repository
   * row's context menus offer it. Absent, the rows have no context menu.
   */
  readonly onDiscard?: (target: DiscardTarget) => void;
};

/**
 * One repository and its changed paths, drawn as the same tree row Files uses:
 * the repository is a row at depth 0 that expands like a directory, and its
 * changed paths are the same `FileTree` rows nested under it. The branch icon
 * and the repository's line totals are that row's own content, not a second
 * header shape. A refresh that answers the same repository leaves the row, and
 * the tree it derives, as they were.
 *
 * With `onDiscard`, a changed file's row has a context menu with "Discard
 * changes" (A11; directory rows have none) and the repository row one with
 * "Discard all changes" (A12).
 */
export const ChangesTree = memo(function ChangesTree({
  repository,
  collapsed,
  selectedPath,
  onToggle,
  onOpen,
  onDiscard,
}: ChangesTreeProps) {
  const { entries, key, open, expanded, decorations, changes } = useMemo(
    () => changesTreeView(repository, '', collapsed),
    [repository, collapsed],
  );
  if (entries.length === 0) return null;
  const label = repository.path || 'workspace';
  const discard = (target: DiscardTarget, text: string): ReactNode => (
    <ContextMenuItem variant="destructive" onClick={() => onDiscard?.(target)}>
      <RotateCcwIcon />
      {text}
    </ContextMenuItem>
  );
  const rowMenu =
    onDiscard === undefined
      ? undefined
      : (node: TreeNode) => {
          const change =
            node.type === 'file' ? changes.get(node.path) : undefined;
          return change === undefined
            ? null
            : discard(
                {
                  name: node.name,
                  repository: repository.path,
                  paths: [change.path],
                },
                'Discard changes',
              );
        };
  const repositoryButton = (
    <SidebarMenuButton
      size="sm"
      className={cn(
        'h-7 w-auto min-w-0 flex-1 gap-1.5 rounded-[4px] pr-1.5',
        noFillButton,
      )}
      style={{ paddingLeft: indentation(0) }}
      render={
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
        />
      }
    >
      <span
        aria-hidden
        className="flex size-4 shrink-0 items-center justify-center [&_svg]:size-3.5!"
      >
        <GitBranchIcon />
      </span>
      <span className="min-w-0 flex-1 truncate font-normal">{label}</span>
    </SidebarMenuButton>
  );
  return (
    <SidebarMenuItem role="presentation" className="w-full min-w-0">
      <div
        className={cn(
          'group/tree-row relative flex w-full min-w-0 items-center',
          rowFill,
          treeitemRing,
        )}
      >
        {onDiscard === undefined ? (
          repositoryButton
        ) : (
          <ContextMenu>
            <ContextMenuTrigger render={repositoryButton} />
            <ContextMenuContent>
              {discard(
                { name: label, repository: repository.path },
                'Discard all changes',
              )}
            </ContextMenuContent>
          </ContextMenu>
        )}
        <span
          aria-hidden
          data-slot="tree-row-mark"
          className="sticky right-1 shrink-0 pr-1 text-sidebar-foreground peer-hover/menu-button:text-sidebar-accent-foreground peer-data-active/menu-button:text-sidebar-accent-foreground"
        >
          <div
            className={cn(
              'flex h-5 min-w-5 items-center justify-center rounded-md px-1 text-xs tabular-nums pointer-events-none select-none',
              markBacking,
            )}
          >
            <Badge variant="ghost" className="px-1" aria-hidden>
              <ChangeCounts
                added={repository.added}
                removed={repository.removed}
              />
            </Badge>
          </div>
        </span>
      </div>
      {open && (
        <SidebarMenuSub
          role="group"
          className={cn(treeClassName, 'overflow-visible')}
        >
          <FileTree
            entries={entries}
            depth={1}
            expanded={expanded}
            decorations={decorations}
            selectedPath={selectedPath}
            rowMenu={rowMenu}
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
});
