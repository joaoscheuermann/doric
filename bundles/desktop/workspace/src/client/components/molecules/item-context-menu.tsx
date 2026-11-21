import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuGroup,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from 'desktop/ui/context-menu';
import {
  ArchiveIcon,
  CopyIcon,
  ExternalLinkIcon,
  MessageSquarePlusIcon,
  PanelRightOpenIcon,
  PinIcon,
  PinOffIcon,
  RotateCcwIcon,
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
  /**
   * Given: "Archive thread" (`ArchiveIcon`), in the group after Copy and
   * before Color and Delete (docs/designs/thread-archive.md §10.5).
   */
  readonly onArchive?: () => void;
  readonly onCopyId?: () => void;
  readonly onDelete?: () => void;
  /** Given: "Restore thread" (`RotateCcwIcon`), in the same group. */
  readonly onRestore?: () => void;
  /** A1: present on Thread rows, which open in a viewer tab (§4.4). */
  readonly onOpenInTab?: () => void;
  /**
   * How A1 reads: "Open in new tab" (external-link) on a main Thread, "Open in
   * viewer" (panel-right-open) on a sub-thread or agent Thread (Figma 29:5448,
   * 29:5496). The action is the same.
   */
  readonly openIn?: 'new-tab' | 'viewer';
  /**
   * Given: "Pin thread" (`PinIcon`) while `pinned` is false, "Unpin thread"
   * (`PinOffIcon`) while true, first in the archive group; choosing it calls
   * `onToggle`.
   */
  readonly pin?: { readonly pinned: boolean; readonly onToggle: () => void };
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
  onArchive,
  onCopyId,
  onDelete,
  onRestore,
  onOpenInTab,
  openIn = 'new-tab',
  pin,
}: ItemContextMenuProps) {
  const adding = onAdd !== undefined && addLabel !== undefined;
  const deleting = onDelete !== undefined && deleteLabel !== undefined;
  const archiving =
    pin !== undefined || onArchive !== undefined || onRestore !== undefined;
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
        {archiving && (
          <>
            {(onOpenInTab !== undefined ||
              adding ||
              onCopyId !== undefined) && <ContextMenuSeparator />}
            <ContextMenuGroup>
              {pin && (
                <ContextMenuItem onClick={pin.onToggle}>
                  {pin.pinned ? <PinOffIcon /> : <PinIcon />}
                  {pin.pinned ? 'Unpin thread' : 'Pin thread'}
                </ContextMenuItem>
              )}
              {onArchive && (
                <ContextMenuItem onClick={onArchive}>
                  <ArchiveIcon />
                  Archive thread
                </ContextMenuItem>
              )}
              {onRestore && (
                <ContextMenuItem onClick={onRestore}>
                  <RotateCcwIcon />
                  Restore thread
                </ContextMenuItem>
              )}
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
