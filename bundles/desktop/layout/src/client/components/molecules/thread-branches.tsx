import {
  indentation,
  rowInteraction,
  TreeGuides,
  treeClassName,
} from 'desktop/ui/panels';
import {
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
} from 'desktop/ui/sidebar';
import { cn } from 'desktop/ui/utils';
import { ChevronRightIcon } from 'lucide-react';

import type { ThreadIconKind } from '../../domain/sidebar.js';
import type { ThreadFilter } from '../../domain/thread-filter.js';
import {
  threadControl,
  threadKind,
  threadKindHint,
} from '../../domain/thread-kind.js';
import type { ThreadLevel } from '../../domain/thread-tree.js';
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
  readonly beginChild: (thread: Thread) => void;
  readonly cancelDraft: () => void;
  readonly cancelRename: () => void;
  readonly copyId: (id: string) => void;
  readonly create: (name: string) => Promise<void>;
  readonly delete: (thread: Thread) => void;
  /** A1 (§4.4): opens the Thread in a viewer tab. */
  readonly openInTab: (thread: Thread) => void;
  readonly rename: (thread: Thread, name: string) => Promise<void>;
  readonly select: (thread: Thread) => void;
  readonly startRename: (thread: Thread) => void;
};

type ThreadBranchesProps = {
  readonly actions: ThreadBranchesActions;
  readonly collapsed: ReadonlySet<string>;
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
  /**
   * The repository each Thread's cwd sits in, decided by the caller from the
   * Thread alone and drawn at the row's trailing edge. It defaults to no
   * repository, so a caller that knows no better draws the rows it always drew.
   */
  readonly repo?: (thread: Thread) => ThreadIconKind;
  readonly level: ThreadLevel;
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
  collapsed,
  depth,
  editingThreadId,
  filter,
  repo = () => 'conversation',
  level,
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
        const running =
          thread.state === 'running' && thread.activePromptId !== undefined;
        const expandable = node.expandable || hasThreadRows(rows, thread.id);
        const expanded =
          expandable &&
          (filter?.expanded.has(thread.id) === true ||
            !collapsed.has(thread.id));
        const kind = threadKind(thread);
        const control = threadControl(thread);
        const repository = repo(thread);
        const marked = control.branches
          ? `New sub-thread in ${thread.name || 'Untitled'}`
          : undefined;
        const addChild = () => {
          onExpand(thread.id);
          actions.beginChild(thread);
        };
        const activate = () => {
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

        return (
          <SidebarMenuSubItem key={thread.id} className="w-full">
            <ItemContextMenu
              {...(marked === undefined
                ? {}
                : { addLabel: marked, onAdd: addChild })}
              {...(control.deletes
                ? {
                    deleteLabel: 'Delete thread',
                    onDelete: () => actions.delete(thread),
                  }
                : {})}
              onCopyId={() => actions.copyId(thread.id)}
              onOpenInTab={() => actions.openInTab(thread)}
              openIn={kind === 'main' ? 'new-tab' : 'viewer'}
            >
              <div className="group/tree-row relative w-full" title={title}>
                <TreeGuides depth={depth} />
                <SidebarMenuSubButton
                  render={
                    <div
                      role="treeitem"
                      tabIndex={0}
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
                    running ? 'pr-16' : 'pr-8',
                    rowInteraction(selected),
                  )}
                  style={{ paddingLeft: indentation(depth) }}
                >
                  {/* One 16 px lead slot (Figma `112:22161`, `99:8035`): the
                      kind icon at rest; on an expandable row, open or closed,
                      the chevron replaces it while the row is hovered or
                      holds focus (CSS only), turned down while open. */}
                  <span
                    aria-hidden
                    data-slot="thread-lead"
                    className="flex size-4 shrink-0 items-center justify-center [&_svg]:size-3.5!"
                  >
                    {expandable ? (
                      <>
                        <ThreadKindIcon
                          kind={kind}
                          className="group-hover/tree-row:hidden group-focus-within/tree-row:hidden"
                        />
                        <ChevronRightIcon
                          className={cn(
                            'hidden group-hover/tree-row:block group-focus-within/tree-row:block',
                            expanded && 'rotate-90',
                          )}
                        />
                      </>
                    ) : (
                      <ThreadKindIcon kind={kind} />
                    )}
                  </span>
                  <EditableName
                    className={cn(running && 'shimmer')}
                    editing={editingThreadId === thread.id}
                    label="Thread name"
                    placeholder="Untitled"
                    value={thread.name}
                    onStart={
                      control.renames
                        ? () => actions.startRename(thread)
                        : undefined
                    }
                    onCancel={actions.cancelRename}
                    onSubmit={(name) => actions.rename(thread, name)}
                  />
                </SidebarMenuSubButton>
                {/* Drawn on every row; its marks show only while the row is
                    hovered or running (`27:13973`). */}
                <RowAddAction
                  label={marked}
                  onAdd={marked === undefined ? undefined : addChild}
                  repo={repository}
                  startedAt={running ? thread.executionStartedAt : undefined}
                />
              </div>
            </ItemContextMenu>
            {expanded && (
              <SidebarMenuSub className={treeClassName}>
                {/* Created through ui/v1, so the element gets its owner's
                    services (WP-10N: the terminal bundle's rows). */}
                {rows.map((entry) => (
                  <ElementHost
                    key={entry.id}
                    tag={entry.tag}
                    props={{ 'thread-id': thread.id }}
                  />
                ))}
                <ThreadBranches
                  actions={actions}
                  collapsed={collapsed}
                  depth={depth + 1}
                  editingThreadId={editingThreadId}
                  {...(filter === undefined ? {} : { filter })}
                  repo={repo}
                  level={node.children}
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
