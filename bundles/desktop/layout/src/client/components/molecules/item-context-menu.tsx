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
  readonly addLabel?: string;
  /** The row the menu opens on: one element, which becomes the trigger. */
  readonly children: ReactElement;
  /** Present only where the row owns a color, so thread rows omit the section. */
  readonly color?: {
    readonly onSelect: (color?: ProjectColor) => void;
    readonly value?: ProjectColor;
  };
  readonly deleteLabel?: string;
  readonly onAdd?: () => void;
  readonly onCopyId?: () => void;
  readonly onDelete?: () => void;
};

/**
 * The add/copy/color/delete menu wrapped around a project or thread row. A row
 * offers only what its kind allows — a sub-thread has no children of its own, and
 * an agent Thread is neither renamed nor deleted by the reader — so each section
 * is drawn only when its action arrives.
 */
export function ItemContextMenu({
  addLabel,
  children,
  color,
  deleteLabel,
  onAdd,
  onCopyId,
  onDelete,
}: ItemContextMenuProps) {
  const adding = onAdd !== undefined && addLabel !== undefined;
  const deleting = onDelete !== undefined && deleteLabel !== undefined;
  return (
    <ContextMenu>
      <ContextMenuTrigger render={children} />
      <ContextMenuContent>
        {(adding || onCopyId !== undefined) && (
          <ContextMenuGroup>
            {adding && (
              <ContextMenuItem onClick={onAdd}>
                <PlusIcon />
                {addLabel}
              </ContextMenuItem>
            )}
            {onCopyId && (
              <ContextMenuItem onClick={onCopyId}>
                <CopyIcon />
                Copy thread ID
              </ContextMenuItem>
            )}
          </ContextMenuGroup>
        )}
        {color && (
          <>
            <ContextMenuSeparator />
            <ProjectColorMenu onSelect={color.onSelect} value={color.value} />
          </>
        )}
        {deleting && (
          <>
            <ContextMenuSeparator />
            <ContextMenuGroup>
              <ContextMenuItem variant="destructive" onClick={onDelete}>
                <Trash2Icon />
                {deleteLabel}
              </ContextMenuItem>
            </ContextMenuGroup>
          </>
        )}
      </ContextMenuContent>
    </ContextMenu>
  );
}
