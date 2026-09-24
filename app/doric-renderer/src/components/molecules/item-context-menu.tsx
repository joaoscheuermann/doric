import { ProjectColorMenu } from '@/components/molecules/project-color-menu';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuGroup,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '@/components/ui/context-menu';
import type { ProjectColor } from '@/domain/workspace';
import { CopyIcon, PlusIcon, Trash2Icon } from 'lucide-react';
import type { ReactNode } from 'react';

type ItemContextMenuProps = {
  readonly addLabel: string;
  readonly children: ReactNode;
  /** Present only where the row owns a color, so thread rows omit the section. */
  readonly color?: {
    readonly onSelect: (color?: ProjectColor) => void;
    readonly value?: ProjectColor;
  };
  readonly deleteLabel: string;
  readonly onAdd: () => void;
  readonly onCopyId?: () => void;
  readonly onDelete: () => void;
};

/** The add/copy/color/delete menu wrapped around a project or thread row. */
export function ItemContextMenu({
  addLabel,
  children,
  color,
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
        {color && (
          <>
            <ContextMenuSeparator />
            <ProjectColorMenu onSelect={color.onSelect} value={color.value} />
          </>
        )}
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
