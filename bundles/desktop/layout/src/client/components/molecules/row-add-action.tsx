import { SidebarMenuAction, SidebarMenuBadge } from 'desktop/ui/sidebar';
import { cn } from 'desktop/ui/utils';
import { PlusIcon } from 'lucide-react';

import type { ThreadIconKind } from '../../domain/sidebar.js';
import { useExecutionTime } from '../../hooks/use-execution-time.js';
import { RepoMark } from './thread-mark.js';

type RowAddActionProps = {
  /**
   * The action's label. Absent where the row opens nothing under it — the row
   * still shows the repository and the agent's elapsed time, which are the
   * mark's and the badge's job, not the button's.
   */
  readonly label?: string;
  readonly onAdd?: () => void;
  /** The repository the Thread's cwd sits in, drawn where the plus appears. */
  readonly repo?: ThreadIconKind;
  readonly startedAt?: string;
};

/**
 * The trailing slot of a tree row: the repository the Thread works in, the time
 * its agent has been running, and the plus that opens a sub-thread
 * (Figma `27:13973`).
 *
 * - "Running" means `startedAt` is given. Its elapsed badge
 *   (`role="status"`, name "Agent running") is drawn at the row's right edge
 *   (`right-1`) whenever the repository mark is hidden, so the time stays
 *   right-aligned. It moves to `right-6` only while the mark shows beside it.
 * - The repository mark (`RepoMark`) is hidden at rest (`opacity-0`). It shows
 *   while the agent runs, and on a row with no plus while the row is hovered
 *   or holds focus (`group-hover/tree-row:opacity-100`,
 *   `group-focus-within/tree-row:opacity-100`).
 * - On a row with a plus (`label` and `onAdd` both given), hover or focus hides
 *   the mark and the badge, and the plus takes their place, as before.
 * - Nothing in the slot takes pointer events except the plus.
 */
export function RowAddAction({
  label,
  onAdd,
  repo,
  startedAt,
}: RowAddActionProps) {
  const elapsed = useExecutionTime(startedAt);
  const addable = label !== undefined && onAdd !== undefined;
  const marked = repo !== undefined && repo !== 'conversation';
  const running = startedAt !== undefined;
  const fade = addable
    ? 'group-hover/tree-row:opacity-0 group-focus-within/tree-row:opacity-0'
    : undefined;
  // At rest the mark shows only while running; an idle row without a plus
  // shows it on hover or focus, and one with a plus never does (§2.3 table).
  const markVisibility = running
    ? fade
    : addable
      ? 'opacity-0'
      : 'opacity-0 group-hover/tree-row:opacity-100 group-focus-within/tree-row:opacity-100';
  return (
    <>
      {elapsed !== undefined && (
        <SidebarMenuBadge
          role="status"
          aria-label="Agent running"
          className={cn(
            'top-1 font-normal',
            marked ? 'right-6' : 'right-1',
            fade,
          )}
        >
          <span aria-hidden>{elapsed}</span>
        </SidebarMenuBadge>
      )}
      {marked && (
        <RepoMark
          className={cn('absolute top-1 right-1 size-5', markVisibility)}
          repo={repo}
        />
      )}
      {addable && (
        <SidebarMenuAction
          type="button"
          className="pointer-events-none right-1 opacity-0 after:inset-0 group-hover/tree-row:pointer-events-auto group-hover/tree-row:opacity-100 group-focus-within/tree-row:pointer-events-auto group-focus-within/tree-row:opacity-100"
          style={{ top: '0.25rem' }}
          aria-label={label}
          onClick={onAdd}
        >
          <PlusIcon />
        </SidebarMenuAction>
      )}
    </>
  );
}
