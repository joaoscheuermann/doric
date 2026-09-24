import { DeleteDialog } from '@/components/molecules/delete-dialog';
import {
  WorkspaceFooter,
  WorkspaceSidebarFooter,
} from '@/components/molecules/workspace-footer';
import { Conversation } from '@/components/organisms/conversation';
import { ProjectFilesSidebar } from '@/components/organisms/project-files-sidebar';
import {
  ProjectSidebar,
  type SidebarActions,
  type SidebarModel,
} from '@/components/organisms/project-sidebar';
import { SettingsDialog } from '@/components/organisms/settings-dialog';
import {
  WorkspaceHeader,
  WorkspaceSidebarHeader,
} from '@/components/organisms/workspace-header';
import { ThreadPane } from '@/components/templates/thread-pane';
import { WorkspaceLayout } from '@/components/templates/workspace-layout';
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty';
import { SidebarInset, SidebarProvider } from '@/components/ui/sidebar';
import { Toaster } from '@/components/ui/sonner';
import { TooltipProvider } from '@/components/ui/tooltip';
import { threadPath } from '@/domain/thread-tree';
import { useWorkspace } from '@/hooks/use-workspace';
import { FileTextIcon } from 'lucide-react';
import { type CSSProperties, useCallback, useState } from 'react';

/** The panel owns the sidebar width, so the sidebar fills whatever it drags to. */
const panelWidth = {
  '--sidebar-width': '100%',
} as CSSProperties;

export function App() {
  const workspace = useWorkspace();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const { actions } = workspace;
  // The sandbox panel, and the count of agent writes that tells it to reread
  // what it shows: the Project owns the sandbox, the Thread only reports.
  const [filesOpen, setFilesOpen] = useState(false);
  const [filesRevision, setFilesRevision] = useState(0);
  const toggleFiles = useCallback(() => setFilesOpen((open) => !open), []);
  const noteSandboxWrite = useCallback(
    () => setFilesRevision((revision) => revision + 1),
    [],
  );
  const model: SidebarModel = {
    draft: workspace.draft,
    editing: workspace.editing,
    error: workspace.error,
    loadingProjects: workspace.loadingProjects,
    loadingProjectThreads: workspace.loadingProjectThreads,
    projects: workspace.projects,
    selectedProjectId: workspace.selectedProjectId,
    selectedThreadId: workspace.selectedThreadId,
    threadsByProject: workspace.threadsByProject,
  };
  const sidebarActions: SidebarActions = {
    beginProject: actions.beginProject,
    beginThread: actions.beginThread,
    cancelDraft: actions.cancelDraft,
    cancelRename: actions.cancelRename,
    copyThreadId: actions.copyThreadId,
    createProject: actions.createProject,
    createThread: actions.createThread,
    deleteEntity: actions.requestDelete,
    rename: actions.rename,
    selectProject: actions.selectProject,
    selectThread: actions.selectThread,
    setProjectColor: actions.setProjectColor,
    startRename: actions.startRename,
  };
  const { selectedThread } = workspace;
  const selectedProject = workspace.projects.find(
    (project) => project.id === workspace.selectedProjectId,
  );
  const selectedThreadPath =
    selectedThread === undefined
      ? []
      : threadPath(
          workspace.threadsByProject[selectedThread.projectId] ?? [],
          selectedThread.id,
        );

  return (
    <TooltipProvider>
      <SidebarProvider
        style={panelWidth}
        className="h-svh min-h-0 flex-col overflow-hidden"
      >
        <WorkspaceLayout
          files={
            <ProjectFilesSidebar
              onToggle={toggleFiles}
              open={filesOpen}
              project={selectedProject}
              revision={filesRevision}
            />
          }
          filesOpen={filesOpen}
          footer={
            <WorkspaceFooter onOpenSettings={() => setSettingsOpen(true)} />
          }
          header={
            <WorkspaceHeader
              filesOpen={filesOpen}
              onSelectProject={actions.selectProject}
              onSelectThread={actions.selectThread}
              onToggleFiles={toggleFiles}
              path={selectedThreadPath}
              project={selectedProject}
            />
          }
          onFilesOpenChange={setFilesOpen}
          sidebar={<ProjectSidebar actions={sidebarActions} model={model} />}
          sidebarFooter={<WorkspaceSidebarFooter />}
          sidebarHeader={<WorkspaceSidebarHeader />}
        >
          <SidebarInset className="min-h-0">
            <ThreadPane>
              {selectedThread ? (
                <Conversation
                  key={selectedThread.id}
                  onSandboxWrite={noteSandboxWrite}
                  thread={selectedThread}
                />
              ) : (
                <Empty>
                  <EmptyHeader>
                    <EmptyMedia variant="icon">
                      <FileTextIcon />
                    </EmptyMedia>
                    <EmptyTitle>No thread selected</EmptyTitle>
                    <EmptyDescription>
                      Select a thread to open its conversation.
                    </EmptyDescription>
                  </EmptyHeader>
                </Empty>
              )}
            </ThreadPane>
          </SidebarInset>
        </WorkspaceLayout>
        <DeleteDialog
          entity={workspace.deleting}
          pending={workspace.deletingPending}
          onDelete={actions.confirmDelete}
          onOpenChange={(open) => {
            if (!open) actions.dismissDelete();
          }}
        />
        <SettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} />
      </SidebarProvider>
      <Toaster />
    </TooltipProvider>
  );
}

export default App;
