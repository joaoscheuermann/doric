import { SidebarMenuAction, SidebarMenuBadge } from 'desktop/ui/sidebar';
import { cn } from 'desktop/ui/utils';
import {
  ArchiveIcon,
  PinIcon,
  PinOffIcon,
  PlusIcon,
  RotateCcwIcon,
  Trash2Icon,
} from 'lucide-react';

import { useExecutionTime } from '../../hooks/use-execution-time.js';

type RowAddActionProps = {
  /**
   * Whether the row is active (`threadActivity` has an entry for it): its
   * Thread runs, a registration answers `busy` for it, or a descendant is
   * active. Only an active row has the "Agent running" status.
   */
  readonly active: boolean;
  /** The plus's label. Absent where the row opens nothing under it: no plus. */
  readonly label?: string;
  /**
   * The 14 px mark the trailing slot shows at rest when no elapsed badge
   * shows: `PinIcon` named "Pinned", or `ArchiveIcon` named "Archived"
   * (docs/designs/thread-archive.md §10.5). Absent: no mark.
   */
  readonly mark?: 'pinned' | 'archived';
  readonly onAdd?: () => void;
  /** Given: the hover action Archive (`ArchiveIcon`, "Archive thread"). */
  readonly onArchive?: () => void;
  /** Given: the hover action Delete (`Trash2Icon`, "Delete thread"). */
  readonly onDelete?: () => void;
  /** Given: the hover action Restore (`RotateCcwIcon`, "Restore thread"). */
  readonly onRestore?: () => void;
  /** Given: the hover action Unpin (`PinOffIcon`, "Unpin thread"). */
  readonly onUnpin?: () => void;
  /**
   * The active row's badge start (`ThreadActivity.startedAt`). Ignored while
   * `active` is false.
   */
  readonly startedAt?: string;
};

/**
 * The trailing slot of a Thread row: the agent's elapsed time and the plus that
 * opens a sub-thread (Figma `27:13973`).
 *
 * - Active with a time (`startedAt` parses): an elapsed badge
 *   (`role="status"`, named "Agent running", text from `elapsedBadge`) at the
 *   row's right edge (`right-1`), counting every second.
 * - Active without a time: a `role="status"` element named "Agent running",
 *   visually hidden (`sr-only`), with no text and nothing on screen, and never
 *   faded.
 * - Not active: no status.
 * - The plus shows only when `label` and `onAdd` are both given. It is hidden
 *   at rest and shows while the row is hovered or holds keyboard focus. Hover
 *   or keyboard focus then hides the elapsed badge
 *   (`group-hover/tree-row:opacity-0`,
 *   `group-has-[:focus-visible]/tree-row:opacity-0`). On a row without the plus the
 *   badge stays.
 * - The plus draws the ghost pressed square on hover and a 2 px
 *   --sidebar-ring outline outside it on keyboard focus (§11.4).
 * - Nothing in the slot takes pointer events except the plus.
 */
const ACTION_PLACES = ['right-1', 'right-7', 'right-13'] as const;

const ACTION_CLASS =
  'pointer-events-none opacity-0 after:inset-0 group-hover/tree-row:pointer-events-auto group-hover/tree-row:opacity-100 group-has-[:focus-visible]/tree-row:pointer-events-auto group-has-[:focus-visible]/tree-row:opacity-100 hover:bg-[var(--paper-ghost-pressed)] focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-[var(--sidebar-ring)]';

const HIDDEN_ON_HOVER =
  'group-hover/tree-row:opacity-0 group-has-[:focus-visible]/tree-row:opacity-0';

export function RowAddAction({
  active,
  label,
  mark,
  onAdd,
  onArchive,
  onDelete,
  onRestore,
  onUnpin,
  startedAt,
}: RowAddActionProps) {
  const elapsed = useExecutionTime(active ? startedAt : undefined);
  // Right to left: each present action takes the next place.
  const actions = [
    label !== undefined && onAdd !== undefined
      ? { label, onClick: onAdd, icon: <PlusIcon /> }
      : undefined,
    onArchive && {
      label: 'Archive thread',
      onClick: onArchive,
      icon: <ArchiveIcon />,
    },
    onUnpin && {
      label: 'Unpin thread',
      onClick: onUnpin,
      icon: <PinOffIcon />,
    },
    onRestore && {
      label: 'Restore thread',
      onClick: onRestore,
      icon: <RotateCcwIcon />,
    },
    onDelete && {
      label: 'Delete thread',
      onClick: onDelete,
      icon: <Trash2Icon />,
    },
  ].filter((action) => action !== undefined);
  const hovered = actions.length > 0;
  const badge = active && elapsed !== undefined;
  return (
    <>
      {badge && (
        <SidebarMenuBadge
          role="status"
          aria-label="Agent running"
          className={cn(
            'top-1 right-1 font-normal',
            hovered && HIDDEN_ON_HOVER,
          )}
        >
          <span aria-hidden>{elapsed}</span>
        </SidebarMenuBadge>
      )}
      {active && elapsed === undefined && (
        <span role="status" aria-label="Agent running" className="sr-only" />
      )}
      {!badge && mark !== undefined && (
        <span
          role="img"
          aria-label={mark === 'pinned' ? 'Pinned' : 'Archived'}
          className={cn(
            'pointer-events-none absolute top-1/2 right-2 flex size-3.5 -translate-y-1/2 items-center text-sidebar-foreground/70 [&>svg]:size-3.5',
            hovered && HIDDEN_ON_HOVER,
          )}
        >
          {mark === 'pinned' ? <PinIcon /> : <ArchiveIcon />}
        </span>
      )}
      {actions.slice(0, ACTION_PLACES.length).map((action, index) => (
        <SidebarMenuAction
          key={action.label}
          type="button"
          className={cn(ACTION_PLACES[index], ACTION_CLASS)}
          style={{ top: '0.25rem' }}
          aria-label={action.label}
          onClick={action.onClick}
        >
          {action.icon}
        </SidebarMenuAction>
      ))}
    </>
  );
}
