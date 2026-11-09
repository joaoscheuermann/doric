import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuGroup,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from 'desktop/ui/context-menu';
import {
  CopyIcon,
  ExternalLinkIcon,
  MessageSquarePlusIcon,
  PanelRightOpenIcon,
  Trash2Icon,
} from 'lucide-react';
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
  /** A1: present on Thread rows, which open in a viewer tab (§4.4). */
  readonly onOpenInTab?: () => void;
  /**
   * How A1 reads: "Open in new tab" (external-link) on a main Thread, "Open in
   * viewer" (panel-right-open) on a sub-thread or agent Thread (Figma 29:5448,
   * 29:5496). The action is the same.
   */
  readonly openIn?: 'new-tab' | 'viewer';
};

/**
 * The open/add/copy/color/delete menu wrapped around a project or thread row. A row
 * offers only what its kind allows — a sub-thread has no children of its own, and
 * an agent Thread is neither renamed nor deleted by the reader — so each section
 * is drawn only when its action arrives. The groups follow Figma
 * `layout/ContextMenu` (29:5570): Open and Create, then Copy, then Color, then
 * Delete last, each behind a separator.
 */
export function ItemContextMenu({
  addLabel,
  children,
  color,
  deleteLabel,
  onAdd,
  onCopyId,
  onDelete,
  onOpenInTab,
  openIn = 'new-tab',
}: ItemContextMenuProps) {
  const adding = onAdd !== undefined && addLabel !== undefined;
  const deleting = onDelete !== undefined && deleteLabel !== undefined;
  return (
    <ContextMenu>
      <ContextMenuTrigger render={children} />
      <ContextMenuContent>
        {(onOpenInTab !== undefined || adding) && (
          <ContextMenuGroup>
            {onOpenInTab && (
              <ContextMenuItem onClick={onOpenInTab}>
                {openIn === 'viewer' ? (
                  <>
                    <PanelRightOpenIcon />
                    Open in viewer
                  </>
                ) : (
                  <>
                    <ExternalLinkIcon />
                    Open in new tab
                  </>
                )}
              </ContextMenuItem>
            )}
            {adding && (
              <ContextMenuItem onClick={onAdd}>
                <MessageSquarePlusIcon />
                {addLabel}
              </ContextMenuItem>
            )}
          </ContextMenuGroup>
        )}
        {onCopyId && (
          <>
            {(onOpenInTab !== undefined || adding) && <ContextMenuSeparator />}
            <ContextMenuGroup>
              <ContextMenuItem onClick={onCopyId}>
                <CopyIcon />
                Copy thread ID
              </ContextMenuItem>
            </ContextMenuGroup>
          </>
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
