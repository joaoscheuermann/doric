import { ComposerButton } from '@/components/molecules/composer-button';
import { ToolbarDivider } from '@/components/molecules/toolbar-divider';
import { ExecutionPicker } from '@/components/organisms/execution-picker';
import { ThreadUsage } from '@/components/organisms/thread-usage';
import { WorkspaceCwd } from '@/components/organisms/workspace-cwd';
import { Button } from '@/components/ui/button';
import { connectionLabel } from '@/domain/connection';
import type { Thread } from '@/domain/workspace';
import { useConnectionStatus } from '@/hooks/use-connection-status';
import type { ProjectFiles } from '@/hooks/use-project-files';
import { SettingsIcon } from 'lucide-react';

type WorkspaceFooterProps = {
  readonly thread?: Thread;
  readonly files: ProjectFiles;
  readonly onShowChanges: () => void;
  /** Whether a prompt is running on the selected Thread. */
  readonly running: boolean;
  /** Whether the prompt holds anything to send. */
  readonly canSend: boolean;
  /** Whether there is a selected Thread to run a prompt on at all. */
  readonly disabled?: boolean;
  readonly onSend: () => void;
  readonly onStop: () => void;
};

/** The conversation footer: working context, changes, execution settings and send/stop. */
export function WorkspaceFooter({
  canSend,
  disabled,
  thread,
  files,
  onShowChanges,
  onSend,
  onStop,
  running,
}: WorkspaceFooterProps) {
  return (
    <footer
      data-slot="workspace-footer"
      className="flex chrome-bar shrink-0 items-center justify-end gap-1 border-t bg-sidebar px-2 text-xs"
    >
      <div className="mr-auto flex min-w-0 flex-1 items-center gap-1">
        <WorkspaceCwd
          key={thread?.id}
          thread={thread}
          changes={files.changes}
          onShowChanges={onShowChanges}
        />
      </div>
      <ExecutionPicker />
      <ThreadUsage thread={thread} />
      <ToolbarDivider />
      <ComposerButton
        canSend={canSend}
        disabled={disabled}
        onSend={onSend}
        onStop={onStop}
        running={running}
      />
    </footer>
  );
}

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
