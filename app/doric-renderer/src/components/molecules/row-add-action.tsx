import { SidebarMenuAction } from '@/components/ui/sidebar';
import { PlusIcon } from 'lucide-react';

type RowAddActionProps = {
  readonly label: string;
  readonly onAdd: () => void;
};

/** The plus button revealed on a tree row's hover or focus. */
export function RowAddAction({ label, onAdd }: RowAddActionProps) {
  return (
    <SidebarMenuAction
      type="button"
      className="pointer-events-none right-1 opacity-0 after:inset-0 group-hover/tree-row:pointer-events-auto group-hover/tree-row:opacity-100 group-focus-within/tree-row:pointer-events-auto group-focus-within/tree-row:opacity-100 [&>svg]:size-3!"
      style={{ top: '0.25rem' }}
      aria-label={label}
      onClick={onAdd}
    >
      <PlusIcon />
    </SidebarMenuAction>
  );
}
