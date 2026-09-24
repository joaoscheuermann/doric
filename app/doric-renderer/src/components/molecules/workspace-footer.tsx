import { Button } from '@/components/ui/button';
import { connectionLabel } from '@/domain/connection';
import { useConnectionStatus } from '@/hooks/use-connection-status';
import { SettingsIcon } from 'lucide-react';

export function WorkspaceSidebarFooter() {
  return (
    <div
      aria-hidden="true"
      data-slot="workspace-sidebar-footer"
      className="h-6 shrink-0 border-t bg-sidebar"
    />
  );
}

type WorkspaceFooterProps = {
  readonly onOpenSettings: () => void;
};

/**
 * The application's status line. The settings trigger sits here rather than in
 * the sidebar so it stays reachable while the sidebar is collapsed.
 */
export function WorkspaceFooter({ onOpenSettings }: WorkspaceFooterProps) {
  const status = useConnectionStatus();

  return (
    <footer
      data-slot="workspace-footer"
      className="flex h-6 shrink-0 items-center justify-end gap-1 border-t px-1 text-xs"
    >
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label="Settings"
        onClick={onOpenSettings}
      >
        <SettingsIcon />
      </Button>
      <span className="px-1">{connectionLabel(status)}</span>
    </footer>
  );
}
