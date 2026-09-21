import { connectionLabel } from '@/app/connection';
import { useConnectionStatus } from '@/hooks/use-connection-status';

export function WorkspaceSidebarFooter() {
  return (
    <div
      aria-hidden="true"
      data-slot="workspace-sidebar-footer"
      className="h-6 shrink-0 border-t bg-sidebar"
    />
  );
}

export function WorkspaceFooter() {
  const status = useConnectionStatus();

  return (
    <footer
      data-slot="workspace-footer"
      className="flex h-6 shrink-0 items-center justify-end border-t px-2 text-xs"
    >
      {connectionLabel(status)}
    </footer>
  );
}
