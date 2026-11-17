import { indentation, TreeGuides, treeClassName } from 'desktop/ui/panels';
import {
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
} from 'desktop/ui/sidebar';
import { cn } from 'desktop/ui/utils';

import {
  noFillButton,
  rowFill,
  textboxRing,
  threadRowPadding,
  treeitemRing,
} from '../../domain/sidebar.js';
import {
  archivable,
  isArchived,
  type SidebarTab,
} from '../../domain/thread-archive.js';
import type { ThreadFilter } from '../../domain/thread-filter.js';
import {
  isUntitled,
  threadControl,
  threadKind,
  threadKindHint,
} from '../../domain/thread-kind.js';
import {
  isThreadRunning,
  type ThreadActivity,
  type ThreadLevel,
} from '../../domain/thread-tree.js';
import type { Thread } from '../../domain/workspace.js';
import { useThreadRows } from '../../hooks/use-thread-rows.js';
import { hasThreadRows } from '../../stores/thread-rows.js';
import { duration } from '../../utility/duration.js';
import { DraftName } from './draft-name.js';
import { EditableName } from './editable-name.js';
import { ElementHost } from './element-host.js';
import { ItemContextMenu } from './item-context-menu.js';
import { RowAddAction } from './row-add-action.js';
import { ThreadKindIcon } from './thread-mark.js';

export type ThreadBranchesActions = {
  /** A Chat row's Archive, on hover and in the menu (§10.5). */
  readonly archive: (thread: Thread) => void;
  readonly beginChild: (thread: Thread) => void;
  readonly cancelDraft: () => void;
  readonly cancelRename: () => void;
  readonly copyId: (id: string) => void;
  readonly create: (name: string) => Promise<void>;
  readonly delete: (thread: Thread) => void;
  /** A1 (§4.4): opens the Thread in a viewer tab. */
  readonly openInTab: (thread: Thread) => void;
  readonly rename: (thread: Thread, name: string) => Promise<void>;
  /** Restore on an Archived row or a Chat context row; shows no toast (§10.6). */
  readonly restore: (thread: Thread) => void;
  readonly select: (thread: Thread) => void;
  /** Pin or Unpin a Chat row (§10.5). */
  readonly setPinned: (thread: Thread, pinned: boolean) => void;
  readonly startRename: (thread: Thread) => void;
};

type ThreadBranchesProps = {
  readonly actions: ThreadBranchesActions;
  /**
   * The active Threads of the whole Project tree (`threadActivity` over the
   * root level), by id, passed unchanged to every level. A row with an entry
   * shimmers and shows the "Agent running" status, and its entry's `startedAt`
   * drives its elapsed badge and padding. A row without one is idle.
   */
  readonly activity: ReadonlyMap<string, ThreadActivity>;
  readonly collapsed: ReadonlySet<string>;
  /**
   * The ids of the context rows of the open sidebar tab (`TabThreads.context`),
   * passed unchanged to every level. Absent: no context row.
   */
  readonly context?: ReadonlySet<string>;
  readonly depth: number;
  readonly editingThreadId?: string;
  /**
   * The sidebar's search (§4.3), passed down to every level. While set, a
   * Thread not in `shown` is not drawn (its `layout.sidebar/v1` rows with it),
   * a Thread in `expanded` is drawn expanded whatever `collapsed` holds, and
   * toggling a row does not write `collapsed`, so clearing the filter draws
   * the tree as it was. Absent: the whole tree, drawn from `collapsed`.
   */
  readonly filter?: ThreadFilter;
  readonly level: ThreadLevel;
  /**
   * The sidebar tab the tree is drawn in, passed unchanged to every level: it
   * picks each row's actions, marks and menu (§10.3, §10.4). Absent: 'chat'.
   */
  readonly mode?: SidebarTab;
  readonly onExpand: (id: string) => void;
  readonly onToggle: (id: string) => void;
  readonly selectedThreadId?: string;
};

/**
 * Renders one level of the thread tree and recurses into each node's children.
 * It reads nothing itself: the level, the selected/editing ids and the row
 * actions all arrive through props.
 */
export function ThreadBranches({
  actions,
  activity,
  collapsed,
  context,
  depth,
  editingThreadId,
  filter,
  level,
  mode = 'chat',
  onExpand,
  onToggle,
  selectedThreadId,
}: ThreadBranchesProps) {
  // Rows other bundles add under each Thread (`layout.sidebar/v1`).
  const rows = useThreadRows();
  return (
    <>
      {level.nodes.map((node) => {
        const { thread } = node;
        if (filter !== undefined && !filter.shown.has(thread.id)) return null;
        const selected = selectedThreadId === thread.id;
        const entry = activity.get(thread.id);
        const running = isThreadRunning(thread);
        // Archived drops the terminal rows; a context row is drawn only to
        // place another row (§10.3, §10.4).
        const archivedTab = mode === 'archived';
        const isContext = context?.has(thread.id) === true;
        const inert = archivedTab && isContext;
        const expandable =
          node.expandable || (!archivedTab && hasThreadRows(rows, thread.id));
        const expanded =
          expandable &&
          (filter?.expanded.has(thread.id) === true ||
            !collapsed.has(thread.id));
        const kind = threadKind(thread);
        const control = threadControl(thread);
        const chatRow = !archivedTab && !isContext;
        const marked =
          chatRow && control.branches
            ? `New sub-thread in ${thread.name || 'Untitled'}`
            : undefined;
        const pinned = thread.pinned === true;
        const restore = () => actions.restore(thread);
        const remove = () => actions.delete(thread);
        const archivedRow = archivedTab && !isContext;
        const hover = {
          ...(chatRow && archivable(thread)
            ? { onArchive: () => actions.archive(thread) }
            : {}),
          ...(chatRow && pinned
            ? { onUnpin: () => actions.setPinned(thread, false) }
            : {}),
          ...(archivedRow ? { onRestore: restore } : {}),
          ...(archivedRow && control.deletes ? { onDelete: remove } : {}),
        };
        const mark =
          pinned && !inert
            ? ('pinned' as const)
            : !archivedTab && isContext
              ? ('archived' as const)
              : undefined;
        const hoverCount = (Object.keys(hover).length +
          (marked === undefined ? 0 : 1)) as 0 | 1 | 2 | 3;
        const timed = entry?.startedAt !== undefined;
        const addChild = () => {
          onExpand(thread.id);
          actions.beginChild(thread);
        };
        const activate = () => {
          if (inert) return;
          // While a query is set the collapsed set is not written (§4.3).
          if (selected && expandable) {
            if (filter === undefined) onToggle(thread.id);
          } else actions.select(thread);
        };
        const title = [
          threadKindHint[kind],
          !running && thread.lastExecutionMs !== undefined
            ? `Last execution: ${duration(thread.lastExecutionMs)}`
            : undefined,
        ]
          .filter((line): line is string => line !== undefined)
          .join('\n');

        const row = (
          <div
            className={cn(
              'group/tree-row relative w-full',
              inert ? 'rounded-[4px]' : rowFill(selected),
              treeitemRing,
              textboxRing,
            )}
            title={title}
          >
            <TreeGuides depth={depth} />
            <SidebarMenuSubButton
              render={
                <div
                  role="treeitem"
                  tabIndex={inert ? -1 : 0}
                  aria-disabled={inert ? true : undefined}
                  aria-expanded={expandable ? expanded : undefined}
                  aria-selected={selected}
                  onClick={activate}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault();
                      activate();
                    }
                  }}
                />
              }
              isActive={selected}
              size="sm"
              className={cn(
                'h-7 w-full translate-x-0 rounded-md',
                threadRowPadding(
                  timed ? 'badge' : mark === undefined ? 'none' : 'mark',
                  hoverCount,
                ),
                noFillButton,
              )}
              style={{ paddingLeft: indentation(depth) }}
            >
              {/* One 16 px lead slot (Figma `112:22161`, `99:8035`): the
                  kind icon, or the Untitled icon for an empty name. */}
              <span
                aria-hidden
                data-slot="thread-lead"
                className={cn(
                  'flex size-4 shrink-0 items-center justify-center [&_svg]:size-3.5!',
                  isContext && 'opacity-50',
                )}
              >
                <ThreadKindIcon kind={kind} untitled={isUntitled(thread)} />
              </span>
              <EditableName
                className={cn(
                  entry !== undefined && 'shimmer',
                  isContext && 'opacity-50',
                )}
                editing={editingThreadId === thread.id}
                label="Thread name"
                placeholder="Untitled"
                value={thread.name}
                onStart={
                  control.renames && !isArchived(thread)
                    ? () => actions.startRename(thread)
                    : undefined
                }
                onCancel={actions.cancelRename}
                onSubmit={(name) => actions.rename(thread, name)}
              />
            </SidebarMenuSubButton>
            {/* Drawn on every row: the elapsed badge while active, the
                plus on hover or focus (`27:13973`). */}
            <RowAddAction
              active={entry !== undefined}
              label={marked}
              {...(mark === undefined ? {} : { mark })}
              onAdd={marked === undefined ? undefined : addChild}
              {...hover}
              startedAt={entry?.startedAt}
            />
          </div>
        );

        return (
          <SidebarMenuSubItem key={thread.id} className="w-full">
            {inert ? (
              row
            ) : (
              <ItemContextMenu
                {...(marked === undefined
                  ? {}
                  : { addLabel: marked, onAdd: addChild })}
                {...(control.deletes && (chatRow || archivedRow)
                  ? { deleteLabel: 'Delete thread', onDelete: remove }
                  : {})}
                {...(hover.onArchive === undefined
                  ? {}
                  : { onArchive: hover.onArchive })}
                {...(isContext || archivedRow ? { onRestore: restore } : {})}
                {...(chatRow
                  ? {
                      pin: {
                        pinned,
                        onToggle: () => actions.setPinned(thread, !pinned),
                      },
                    }
                  : {})}
                onCopyId={() => actions.copyId(thread.id)}
                onOpenInTab={() => actions.openInTab(thread)}
                openIn={kind === 'main' ? 'new-tab' : 'viewer'}
              >
                {row}
              </ItemContextMenu>
            )}
            {expanded && (
              <SidebarMenuSub className={treeClassName}>
                {/* Created through ui/v1, so the element gets its owner's
                    services (WP-10N: the terminal bundle's rows). */}
                {!archivedTab &&
                  rows.map((entry) => (
                    <ElementHost
                      key={entry.id}
                      tag={entry.tag}
                      props={{ 'thread-id': thread.id }}
                    />
                  ))}
                <ThreadBranches
                  actions={actions}
                  activity={activity}
                  collapsed={collapsed}
                  {...(context === undefined ? {} : { context })}
                  depth={depth + 1}
                  editingThreadId={editingThreadId}
                  {...(filter === undefined ? {} : { filter })}
                  level={node.children}
                  mode={mode}
                  onExpand={onExpand}
                  onToggle={onToggle}
                  selectedThreadId={selectedThreadId}
                />
              </SidebarMenuSub>
            )}
          </SidebarMenuSubItem>
        );
      })}
      {level.draft && (
        <SidebarMenuSubItem className="w-full">
          <DraftName
            depth={depth}
            label={depth === 0 ? 'New thread name' : 'New sub-thread name'}
            onCancel={actions.cancelDraft}
            onSubmit={actions.create}
          />
        </SidebarMenuSubItem>
      )}
    </>
  );
}
