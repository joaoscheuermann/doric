import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuGroup,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '@/components/ui/context-menu';
import { CopyIcon, PlusIcon, Trash2Icon } from 'lucide-react';
import type { ReactNode } from 'react';

type ItemContextMenuProps = {
  readonly addLabel: string;
  readonly children: ReactNode;
  readonly deleteLabel: string;
  readonly onAdd: () => void;
  readonly onCopyId?: () => void;
  readonly onDelete: () => void;
};

/** The add/copy/delete menu wrapped around a project or thread row. */
export function ItemContextMenu({
  addLabel,
  children,
  deleteLabel,
  onAdd,
  onCopyId,
  onDelete,
}: ItemContextMenuProps) {
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuGroup>
          <ContextMenuItem onSelect={onAdd}>
            <PlusIcon />
            {addLabel}
          </ContextMenuItem>
          {onCopyId && (
            <ContextMenuItem onSelect={onCopyId}>
              <CopyIcon />
              Copy thread ID
            </ContextMenuItem>
          )}
        </ContextMenuGroup>
        <ContextMenuSeparator />
        <ContextMenuGroup>
          <ContextMenuItem variant="destructive" onSelect={onDelete}>
            <Trash2Icon />
            {deleteLabel}
          </ContextMenuItem>
        </ContextMenuGroup>
      </ContextMenuContent>
    </ContextMenu>
  );
}
