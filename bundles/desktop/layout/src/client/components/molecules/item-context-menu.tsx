import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuGroup,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from 'desktop/ui/context-menu';
import { CopyIcon, PlusIcon, Trash2Icon } from 'lucide-react';
import type { ReactElement } from 'react';

import type { ProjectColor } from '../../domain/workspace.js';
import { ProjectColorMenu } from './project-color-menu.js';

type ItemContextMenuProps = {
  readonly addLabel: string;
  /** The row the menu opens on: one element, which becomes the trigger. */
  readonly children: ReactElement;
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
      <ContextMenuTrigger render={children} />
      <ContextMenuContent>
        <ContextMenuGroup>
          <ContextMenuItem onClick={onAdd}>
            <PlusIcon />
            {addLabel}
          </ContextMenuItem>
          {onCopyId && (
            <ContextMenuItem onClick={onCopyId}>
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
          <ContextMenuItem variant="destructive" onClick={onDelete}>
            <Trash2Icon />
            {deleteLabel}
          </ContextMenuItem>
        </ContextMenuGroup>
      </ContextMenuContent>
    </ContextMenu>
  );
}
