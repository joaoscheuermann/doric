import { SidebarMenuAction, SidebarMenuBadge } from 'desktop/ui/sidebar';
import { cn } from 'desktop/ui/utils';
import { PlusIcon } from 'lucide-react';

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
  readonly onAdd?: () => void;
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
 *   at rest and shows while the row is hovered or holds focus. Hover or focus
 *   then hides the elapsed badge (`group-hover/tree-row:opacity-0`,
 *   `group-focus-within/tree-row:opacity-0`). On a row without the plus the
 *   badge stays.
 * - Nothing in the slot takes pointer events except the plus.
 */
export function RowAddAction({
  active,
  label,
  onAdd,
  startedAt,
}: RowAddActionProps) {
  const elapsed = useExecutionTime(active ? startedAt : undefined);
  const addable = label !== undefined && onAdd !== undefined;
  return (
    <>
      {active && elapsed !== undefined && (
        <SidebarMenuBadge
          role="status"
          aria-label="Agent running"
          className={cn(
            'top-1 right-1 font-normal',
            addable &&
              'group-hover/tree-row:opacity-0 group-focus-within/tree-row:opacity-0',
          )}
        >
          <span aria-hidden>{elapsed}</span>
        </SidebarMenuBadge>
      )}
      {active && elapsed === undefined && (
        <span role="status" aria-label="Agent running" className="sr-only" />
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
