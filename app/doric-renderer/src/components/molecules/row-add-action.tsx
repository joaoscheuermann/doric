import { PlusIcon } from 'lucide-react';

import { SidebarMenuAction, SidebarMenuBadge } from '@/components/ui/sidebar';
import { useExecutionTime } from '@/hooks/use-execution-time';

type RowAddActionProps = {
  readonly label: string;
  readonly onAdd: () => void;
  readonly startedAt?: string;
};

/** The plus button revealed on a tree row's hover or focus. */
export function RowAddAction({ label, onAdd, startedAt }: RowAddActionProps) {
  const elapsed = useExecutionTime(startedAt);
  return (
    <>
      {elapsed !== undefined && (
        <SidebarMenuBadge
          role="status"
          aria-label="Agent running"
          className="top-1 right-1 font-light group-hover/tree-row:opacity-0 group-focus-within/tree-row:opacity-0"
        >
          <span aria-hidden>{elapsed}</span>
        </SidebarMenuBadge>
      )}
      <SidebarMenuAction
        type="button"
        className="pointer-events-none right-1 opacity-0 after:inset-0 group-hover/tree-row:pointer-events-auto group-hover/tree-row:opacity-100 group-focus-within/tree-row:pointer-events-auto group-focus-within/tree-row:opacity-100"
        style={{ top: '0.25rem' }}
        aria-label={label}
        onClick={onAdd}
      >
        <PlusIcon />
      </SidebarMenuAction>
    </>
  );
}
