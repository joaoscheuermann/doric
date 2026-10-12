import { Button } from 'desktop/ui/button';
import { Separator } from 'desktop/ui/separator';
import { useSidebar } from 'desktop/ui/sidebar';
import { PanelLeftCloseIcon, PanelLeftOpenIcon } from 'lucide-react';
import type { ReactNode } from 'react';

import type { Project, Thread } from '../../domain/workspace.js';
import { ThreadBreadcrumb } from '../molecules/thread-breadcrumb.js';

type WorkspaceHeaderProps = {
  /**
   * The `layout.header` region (stage 9 §5.4): other bundles' header items
   * after the breadcrumb — the terminal bundle's "New terminal" button, then
   * the files bundle's panel toggle while the panel is closed (WP-10N).
   */
  readonly actions?: ReactNode;
  readonly onSelectProject: (project: Project) => void;
  readonly onSelectThread: (thread: Thread) => void;
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
      className="relative flex chrome-bar shrink-0 items-center bg-sidebar pl-20 [app-region:drag]"
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
  onSelectProject,
  onSelectThread,
  path,
  project,
  actions,
}: WorkspaceHeaderProps) {
  const { open } = useSidebar();

  return (
    <header
      data-slot="workspace-header"
      className="relative flex chrome-bar shrink-0 items-center bg-sidebar [app-region:drag]"
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
      {actions}
    </header>
  );
}
