import { FilesToggle } from '@/components/molecules/files-toggle';
import { ThreadBreadcrumb } from '@/components/molecules/thread-breadcrumb';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import { useSidebar } from '@/components/ui/sidebar';
import type { Project, Thread } from '@/domain/workspace';
import { PanelLeftCloseIcon, PanelLeftOpenIcon } from 'lucide-react';

type WorkspaceHeaderProps = {
  /** Whether the Project's sandbox panel is open. */
  readonly filesOpen?: boolean;
  readonly onSelectProject: (project: Project) => void;
  readonly onSelectThread: (thread: Thread) => void;
  /**
   * Shows and hides the Project's sandbox panel. While that panel is closed
   * this header carries the control at its right corner, because a closed panel
   * draws nothing of its own; absent when there is no such panel.
   */
  readonly onToggleFiles?: () => void;
  /** The chain from the outermost Thread down to the selected one. */
  readonly path: readonly Thread[];
  readonly project?: Project;
};

function SidebarToggle() {
  const { open, toggleSidebar } = useSidebar();

  return (
    <Button
      variant="ghost"
      size="icon-sm"
      aria-label={open ? 'Hide sidebar' : 'Show sidebar'}
      className="self-center [app-region:no-drag]"
      onClick={toggleSidebar}
    >
      {open ? <PanelLeftCloseIcon /> : <PanelLeftOpenIcon />}
    </Button>
  );
}

export function WorkspaceSidebarHeader() {
  return (
    <div
      data-slot="workspace-sidebar-header"
      className="relative flex h-8 shrink-0 items-center bg-sidebar pl-20 [app-region:drag]"
    >
      <Separator className="pointer-events-none absolute inset-x-0 bottom-0 [app-region:no-drag]" />
      <SidebarToggle />
    </div>
  );
}

/**
 * The main header. Two controls move between here and the panel they belong to,
 * so each stays reachable: the sidebar's toggle while the sidebar is closed, and
 * the sandbox panel's toggle while that panel is closed, since a closed panel
 * draws nothing of its own.
 */
export function WorkspaceHeader({
  filesOpen = false,
  onSelectProject,
  onSelectThread,
  onToggleFiles,
  path,
  project,
}: WorkspaceHeaderProps) {
  const { open } = useSidebar();

  return (
    <header
      data-slot="workspace-header"
      className="relative flex h-8 shrink-0 items-center bg-sidebar [app-region:drag]"
    >
      <Separator className="pointer-events-none absolute inset-x-0 bottom-0 [app-region:no-drag]" />
      {!open && (
        <div className="flex h-full shrink-0 items-center pl-20">
          <SidebarToggle />
        </div>
      )}
      <div className="relative z-10 flex h-full min-w-0 flex-1 items-center px-3">
        <ThreadBreadcrumb
          onSelectProject={onSelectProject}
          onSelectThread={onSelectThread}
          path={path}
          project={project}
        />
      </div>
      {!filesOpen && onToggleFiles !== undefined && (
        <div className="flex h-full shrink-0 items-center pr-2">
          <FilesToggle onToggle={onToggleFiles} />
        </div>
      )}
    </header>
  );
}
