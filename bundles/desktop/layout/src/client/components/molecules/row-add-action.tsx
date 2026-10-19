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
 * its agent has been running, and the plus that opens a sub-thread. The plus
 * takes the mark's place on hover, so the row says where it works at rest and
 * what it can open under focus. What a row cannot open under — a sub-thread, an
 * agent Thread — keeps its mark: a Thread still works in a repository even when
 * the reader may not branch it.
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
  const fade = addable
    ? 'group-hover/tree-row:opacity-0 group-focus-within/tree-row:opacity-0'
    : undefined;
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
          className={cn('absolute top-1 right-1 size-5', fade)}
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
