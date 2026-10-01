import { DeleteDialog } from '@/components/molecules/delete-dialog';
import { Conversation } from '@/components/organisms/conversation';
import { FileViewer } from '@/components/organisms/file-viewer';
import { ProjectFilesSidebar } from '@/components/organisms/project-files-sidebar';
import {
  ProjectSidebar,
  type SidebarActions,
  type SidebarModel,
} from '@/components/organisms/project-sidebar';
import {
  WorkspaceFooter,
  WorkspaceSidebarFooter,
} from '@/components/organisms/workspace-footer';
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
  EmptyTitle,
} from '@/components/ui/empty';
import { SidebarInset, SidebarProvider } from '@/components/ui/sidebar';
import { Toaster } from '@/components/ui/sonner';
import { TooltipProvider } from '@/components/ui/tooltip';
import { threadPath } from '@/domain/thread-tree';
import { useProjectFiles } from '@/hooks/use-project-files';
import { useWorkspace } from '@/hooks/use-workspace';
import { createPromptSignal } from '@/utility/prompt-signal';
import {
  type CSSProperties,
  useCallback,
  useState,
  useSyncExternalStore,
} from 'react';

/** The panel owns the sidebar width, so the sidebar fills whatever it drags to. */
const panelWidth = {
  '--sidebar-width': '100%',
} as CSSProperties;

export function App() {
  const workspace = useWorkspace();
  const { actions } = workspace;
  // The sandbox panel starts open, and stays where the user leaves it; the
  // count of agent writes below is what tells it to reread what it shows: the
  // Project owns the sandbox, the Thread only reports.
  const [filesOpen, setFilesOpen] = useState(true);
  const [filesRevision, setFilesRevision] = useState(0);
  // What the conversation's composer offers the footer, and how the two talk.
  //
  // The prompt lives in the editor and the control lives in the shell, so the
  // fact that the prompt is empty has to cross between them. It crosses as a
  // value the shell owns: the editor writes it, the shell reads it through
  // `useSyncExternalStore`, and the child's props are the same object whatever it
  // writes. Nothing sets the shell's state from the child — that is a write
  // during the shell's commit, which is what a render loop is made of — and the
  // signal only speaks when the value changes, so a write cannot become a second
  // render and a render a second write.
  //
  // Sending goes the other way for the same reason: the shell counts requests and
  // the editor answers each new count once.
  const [promptSignal] = useState(createPromptSignal);
  const canSend = useSyncExternalStore(
    promptSignal.subscribe,
    promptSignal.snapshot,
  );
  const [sendRequest, setSendRequest] = useState(0);
  const send = useCallback(() => setSendRequest((count) => count + 1), []);
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
  const activePromptId = selectedThread?.activePromptId;
  const running =
    selectedThread?.state === 'running' && activePromptId !== undefined;
  // A refusal is the run having settled first, which is the same outcome the
  // reader asked for; there is nothing left to report.
  const stop = useCallback(() => {
    if (selectedThread === undefined || activePromptId === undefined) return;
    void window.doric.threads
      .interrupt(selectedThread.id, activePromptId)
      .catch(() => undefined);
  }, [activePromptId, selectedThread]);
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
  // The sandbox and the file viewer show the same read: a closed panel reads
  // nothing, and the file viewer is drawn from the one file this holds.
  const files = useProjectFiles({
    projectId: filesOpen ? selectedProject?.id : undefined,
    revision: filesRevision,
  });
  const openFilePath = files.selectedPath;
  const closeFile = files.actions.closeFile;

  return (
    <TooltipProvider>
      <SidebarProvider
        style={panelWidth}
        className="h-svh min-h-0 flex-col overflow-hidden"
      >
        <WorkspaceLayout
          files={
            <ProjectFilesSidebar
              files={files}
              onToggle={toggleFiles}
              project={selectedProject}
            />
          }
          filesOpen={filesOpen}
          fileViewer={
            openFilePath === undefined ? undefined : (
              <FileViewer
                file={files.file}
                onClose={closeFile}
                path={openFilePath}
              />
            )
          }
          footer={
            <WorkspaceFooter
              canSend={canSend}
              disabled={selectedThread === undefined}
              onSend={send}
              onStop={stop}
              running={running}
            />
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
          sidebarFooter={
            <WorkspaceSidebarFooter
              onOpenSettings={() => void window.doric.settings.open()}
            />
          }
          sidebarHeader={<WorkspaceSidebarHeader />}
        >
          <SidebarInset className="min-h-0">
            <ThreadPane>
              {selectedThread ? (
                <Conversation
                  key={selectedThread.id}
                  onSandboxWrite={noteSandboxWrite}
                  promptSignal={promptSignal}
                  sendRequest={sendRequest}
                  thread={selectedThread}
                />
              ) : (
                <Empty>
                  <EmptyHeader>
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
      </SidebarProvider>
      <Toaster />
    </TooltipProvider>
  );
}

export default App;
