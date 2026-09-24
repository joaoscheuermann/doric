import { ThreadBreadcrumb } from '@/components/molecules/thread-breadcrumb';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import { useSidebar } from '@/components/ui/sidebar';
import type { Project, Thread } from '@/domain/workspace';
import { PanelLeftCloseIcon, PanelLeftOpenIcon } from 'lucide-react';

type WorkspaceHeaderProps = {
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
      className="relative flex h-8 shrink-0 items-center bg-sidebar pl-20 [app-region:drag]"
    >
      <Separator className="pointer-events-none absolute inset-x-0 bottom-0 [app-region:no-drag]" />
      <SidebarToggle />
    </div>
  );
}

export function WorkspaceHeader({
  onSelectProject,
  onSelectThread,
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
    </header>
  );
}
