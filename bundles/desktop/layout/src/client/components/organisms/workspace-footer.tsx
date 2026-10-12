import { Button } from 'desktop/ui/button';
import { SettingsIcon } from 'lucide-react';

import { connectionLabel } from '../../domain/connection.js';
import { useConnectionStatus } from '../../hooks/use-connection-status.js';

// The content footer of the old renderer is now the `layout.footer` region
// (stage 9 §5.4): its cells are the region's items (cwd 10, execution 20,
// usage 30, composer 40). What stays here is the sidebar's status line.

/** The main process's Socket.IO connection status, as the reader reads it. */
function ConnectionStatus() {
  const status = useConnectionStatus();

  return <span className="px-1">{connectionLabel(status)}</span>;
}

type WorkspaceSidebarFooterProps = {
  readonly onOpenSettings: () => void;
};

/**
 * The sidebar's own status line, sharing the footer's geometry on the menu side.
 * It states the connection to the host, so the content footer is free for what a
 * prompt runs with, and it carries the settings trigger at its far end, where a
 * menu's gear belongs — reachable while the sidebar is open and out of the way of
 * the composer.
 */
export function WorkspaceSidebarFooter({
  onOpenSettings,
}: WorkspaceSidebarFooterProps) {
  return (
    <div
      data-slot="workspace-sidebar-footer"
      className="flex chrome-bar shrink-0 items-center border-t bg-sidebar px-1 text-xs text-muted-foreground"
    >
      <ConnectionStatus />
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label="Settings"
        className="ml-auto"
        onClick={onOpenSettings}
      >
        <SettingsIcon />
      </Button>
    </div>
  );
}
