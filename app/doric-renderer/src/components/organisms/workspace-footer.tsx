import { ToolbarDivider } from '@/components/molecules/toolbar-divider';
import { ExecutionPicker } from '@/components/organisms/execution-picker';
import { Button } from '@/components/ui/button';
import { connectionLabel } from '@/domain/connection';
import { useConnectionStatus } from '@/hooks/use-connection-status';
import { SettingsIcon } from 'lucide-react';

type WorkspaceFooterProps = {
  readonly onOpenSettings: () => void;
};

/**
 * The application's status line, under the conversation. It carries the
 * execution picker — the model, thinking and effort a prompt runs with — and the
 * settings trigger, which sits here rather than in the sidebar so it stays
 * reachable while the sidebar is collapsed.
 */
export function WorkspaceFooter({ onOpenSettings }: WorkspaceFooterProps) {
  return (
    <footer
      data-slot="workspace-footer"
      className="flex h-8 shrink-0 items-center justify-end gap-1 border-t px-2 text-xs"
    >
      <ExecutionPicker />
      <ToolbarDivider />
      <Button
        variant="ghost"
        size="icon-xs"
        aria-label="Settings"
        onClick={onOpenSettings}
      >
        <SettingsIcon />
      </Button>
    </footer>
  );
}

/** The main process's Socket.IO connection status, as the reader reads it. */
function ConnectionStatus() {
  const status = useConnectionStatus();

  return <span className="px-1">{connectionLabel(status)}</span>;
}

/**
 * The sidebar's own status line, sharing the footer's geometry on the menu side.
 * It states the connection to the host, so the content footer is free for what a
 * prompt runs with.
 */
export function WorkspaceSidebarFooter() {
  return (
    <div
      data-slot="workspace-sidebar-footer"
      className="flex h-8 shrink-0 items-center border-t bg-sidebar px-1 text-xs text-muted-foreground"
    >
      <ConnectionStatus />
    </div>
  );
}
