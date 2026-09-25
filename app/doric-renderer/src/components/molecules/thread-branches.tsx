import { DraftName } from '@/components/molecules/draft-name';
import { EditableName } from '@/components/molecules/editable-name';
import { ItemContextMenu } from '@/components/molecules/item-context-menu';
import { RowAddAction } from '@/components/molecules/row-add-action';
import {
  indentation,
  rowInteraction,
  treeClassName,
  TreeGuides,
} from '@/components/molecules/tree-guides';
import {
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
} from '@/components/ui/sidebar';
import { isExpanded, type ThreadLevel } from '@/domain/thread-tree';
import type { Thread } from '@/domain/workspace';
import { cn } from '@/utility/utils';
import { ChevronRightIcon, MessageSquareIcon } from 'lucide-react';

export type ThreadBranchesActions = {
  readonly beginChild: (thread: Thread) => void;
  readonly cancelDraft: () => void;
  readonly cancelRename: () => void;
  readonly copyId: (id: string) => void;
  readonly create: (name: string) => Promise<void>;
  readonly delete: (thread: Thread) => void;
  readonly rename: (thread: Thread, name: string) => Promise<void>;
  readonly select: (thread: Thread) => void;
  readonly startRename: (thread: Thread) => void;
};

type ThreadBranchesProps = {
  readonly actions: ThreadBranchesActions;
  readonly collapsed: ReadonlySet<string>;
  readonly depth: number;
  readonly editingThreadId?: string;
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
  level,
  onExpand,
  onToggle,
  selectedThreadId,
}: ThreadBranchesProps) {
  return (
    <>
      {level.nodes.map((node) => {
        const { thread } = node;
        const selected = selectedThreadId === thread.id;
        const expanded = isExpanded(node, collapsed);
        const addChild = () => {
          onExpand(thread.id);
          actions.beginChild(thread);
        };
        const activate = () => {
          if (selected && node.expandable) onToggle(thread.id);
          else actions.select(thread);
        };

        return (
          <SidebarMenuSubItem key={thread.id} className="w-full">
            <ItemContextMenu
              addLabel="New child thread"
              deleteLabel="Delete thread"
              onAdd={addChild}
              onCopyId={() => actions.copyId(thread.id)}
              onDelete={() => actions.delete(thread)}
            >
              <div className="group/tree-row relative w-full">
                <TreeGuides depth={depth} />
                <SidebarMenuSubButton
                  asChild
                  isActive={selected}
                  size="sm"
                  className={cn(
                    'h-7 w-full translate-x-0 rounded-none pr-8 [&>svg]:size-3.5!',
                    rowInteraction(selected),
                  )}
                  style={{ paddingLeft: indentation(depth) }}
                >
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
                  >
                    <MessageSquareIcon />
                    {node.expandable && (
                      <ChevronRightIcon
                        aria-hidden
                        className={cn(
                          'transition-transform duration-[50ms] ease-out',
                          expanded ? 'rotate-90' : 'rotate-0',
                        )}
                      />
                    )}
                    <EditableName
                      editing={editingThreadId === thread.id}
                      label="Thread name"
                      value={thread.name}
                      onStart={() => actions.startRename(thread)}
                      onCancel={actions.cancelRename}
                      onSubmit={(name) => actions.rename(thread, name)}
                    />
                  </div>
                </SidebarMenuSubButton>
                <RowAddAction
                  label={`New child thread in ${thread.name}`}
                  onAdd={addChild}
                />
              </div>
            </ItemContextMenu>
            {expanded && (
              <SidebarMenuSub className={treeClassName}>
                <ThreadBranches
                  actions={actions}
                  collapsed={collapsed}
                  depth={depth + 1}
                  editingThreadId={editingThreadId}
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
            label="New thread name"
            onCancel={actions.cancelDraft}
            onSubmit={actions.create}
          />
        </SidebarMenuSubItem>
      )}
    </>
  );
}
