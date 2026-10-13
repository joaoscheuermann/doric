import { Button } from 'desktop/ui/button';
import { SettingsIcon } from 'lucide-react';
import { createElement } from 'react';

import { connectionLabel } from '../../domain/connection.js';
import { useConnectionStatus } from '../../hooks/use-connection-status.js';

// The window's single footer: one bar across the whole workspace, on the
// dashboard and on every project screen, where what the reader reaches for
// from anywhere lives — the host connection, the machine and sandbox
// resources (`layout.global-footer`) and the settings trigger at its far
// end. The conversation keeps its own bar inside its container, and the
// sidebars and the sandbox panel carry no footer of their own anymore.

/** A `<core-region name>`: `display: contents`, no role of its own. */
const Region = ({ name }: { readonly name: string }) =>
  createElement('core-region', { name });

/** The main process's Socket.IO connection status, as the reader reads it. */
function ConnectionStatus() {
  const status = useConnectionStatus();

  return <span className="px-1">{connectionLabel(status)}</span>;
}

type WorkspaceGlobalFooterProps = {
  readonly onOpenSettings: () => void;
};

/**
 * The window's own status line: connection, hardware, settings, all at the
 * right end — reachable on every screen, dashboard included, because a
 * reader checks these wherever they are, not only while a project is open.
 */
export function WorkspaceGlobalFooter({
  onOpenSettings,
}: WorkspaceGlobalFooterProps) {
  return (
    <footer
      data-slot="workspace-global-footer"
      className="flex h-8 shrink-0 items-center justify-end gap-1.5 border-t bg-sidebar px-2 text-xs text-muted-foreground"
    >
      <ConnectionStatus />
      <Region name="layout.global-footer" />
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label="Settings"
        onClick={onOpenSettings}
      >
        <SettingsIcon />
      </Button>
    </footer>
  );
}
