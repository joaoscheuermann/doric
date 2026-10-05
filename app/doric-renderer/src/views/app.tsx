import { DeleteDialog } from '@/components/molecules/delete-dialog';
import { Conversation } from '@/components/organisms/conversation';
import { ManualTerminalTabs } from '@/components/organisms/manual-terminal-tabs';
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
import { WorkspaceTabs } from '@/components/organisms/workspace-tabs';
import { ConversationTerminals } from '@/components/templates/conversation-terminals';
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
import { joinPath } from '@/domain/files';
import type { Terminal } from '@/domain/terminals';
import { threadPath } from '@/domain/thread-tree';
import type { ProjectChange } from '@/domain/workspace';
import { useComposer } from '@/hooks/use-composer';
import { useProjectFiles } from '@/hooks/use-project-files';
import { useProjectRefresh } from '@/hooks/use-project-refresh';
import { useTerminals } from '@/hooks/use-terminals';
import { useWorkspace } from '@/hooks/use-workspace';
import { useWorkspaceTabs } from '@/hooks/use-workspace-tabs';
import { workspaceTabsStore } from '@/stores/workspace-tabs';
import { type CSSProperties, useCallback, useState } from 'react';

/** The panel owns the sidebar width, so the sidebar fills whatever it drags to. */
const panelWidth = {
  '--sidebar-width': '100%',
} as CSSProperties;

export function App() {
  const workspace = useWorkspace();
  const terminals = useTerminals(workspace.projects);
  const tabOwner =
    workspace.selectedThreadId ??
    (workspace.selectedProjectId
      ? `project:${workspace.selectedProjectId}`
      : undefined);
  const tabs = useWorkspaceTabs(tabOwner);
  const { actions } = workspace;
  // The sandbox panel starts open and keeps the reader's choice.
  const [filesOpen, setFilesOpen] = useState(true);
  const [filesView, setFilesView] = useState<'files' | 'changes'>('files');
  // What the conversation's composer offers the footer, and how the two talk.
  const { promptSignal, sendRequest, canSend, send } = useComposer();
  const toggleFiles = useCallback(() => setFilesOpen((open) => !open), []);
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
  useProjectRefresh({
    project: selectedProject,
    thread: selectedThread,
    threads: workspace.threadsByProject[selectedProject?.id ?? ''] ?? [],
    terminals: terminals.items,
    visible:
      filesOpen ||
      selectedThread !== undefined ||
      tabs.items.some((tab) => tab.kind !== 'terminal'),
  });
  const selectedThreadPath =
    selectedThread === undefined
      ? []
      : threadPath(
          workspace.threadsByProject[selectedThread.projectId] ?? [],
          selectedThread.id,
        );
  // Git totals remain visible in the footer; only the tree pauses with the panel.
  const files = useProjectFiles({
    projectId: selectedProject?.id,
    treeEnabled: filesOpen,
    cwd: selectedThread?.cwd,
  });
  const tabActions = workspaceTabsStore.getState();
  const selectedTab = tabs.items.find((tab) => tab.id === tabs.selected);
  const openChange = (repository: string, change: ProjectChange) => {
    if (!tabOwner || !selectedProject) return;
    tabActions.open(tabOwner, {
      kind: 'diff',
      id: JSON.stringify(['diff', selectedProject.id, repository, change.path]),
      projectId: selectedProject.id,
      repository,
      path: change.path,
    });
  };
  const filesWithTabs = {
    ...files,
    selectedPath: selectedTab?.kind === 'file' ? selectedTab.path : undefined,
    actions: {
      ...files.actions,
      openFile: (path: string) => {
        if (!tabOwner || !selectedProject) return;
        tabActions.open(tabOwner, {
          kind: 'file',
          id: `file:${path}`,
          path,
          projectId: selectedProject.id,
        });
      },
    },
  };
  const openTerminal = (terminal: Terminal) => {
    const thread = workspace.threadsByProject[terminal.projectId]?.find(
      (item) => item.id === terminal.threadId,
    );
    if (thread) actions.selectThread(thread);
    if (terminal.origin === 'user')
      tabActions.manual(terminal.threadId, terminal.id);
    else
      tabActions.open(terminal.threadId, {
        kind: 'terminal',
        id: `terminal:${terminal.id}`,
        terminalId: terminal.id,
      });
  };
  const manual = terminals.items.find(
    (terminal) => terminal.id === tabs.manualId,
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
              files={filesWithTabs}
              onOpenChange={openChange}
              selectedChangePath={
                selectedTab?.kind === 'diff'
                  ? joinPath(selectedTab.repository, selectedTab.path)
                  : undefined
              }
              onToggle={toggleFiles}
              project={selectedProject}
              view={filesView}
              onViewChange={setFilesView}
            />
          }
          filesOpen={filesOpen}
          fileViewer={
            tabs.items.length === 0 || !tabOwner ? undefined : (
              <WorkspaceTabs
                state={tabs}
                threadId={tabOwner}
                terminals={terminals.items}
              />
            )
          }
          footer={
            <WorkspaceFooter
              thread={selectedThread}
              files={files}
              onShowChanges={() => {
                setFilesView('changes');
                setFilesOpen(true);
              }}
              canSend={canSend}
              disabled={selectedThread === undefined}
              onSend={send}
              onStop={stop}
              running={running}
            />
          }
          header={
            <WorkspaceHeader
              onNewTerminal={
                selectedThread
                  ? () => void terminals.create(selectedThread.id)
                  : undefined
              }
              filesOpen={filesOpen}
              onSelectProject={actions.selectProject}
              onSelectThread={actions.selectThread}
              onToggleFiles={toggleFiles}
              path={selectedThreadPath}
              project={selectedProject}
            />
          }
          onFilesOpenChange={setFilesOpen}
          sidebar={
            <ProjectSidebar
              actions={sidebarActions}
              model={model}
              terminals={terminals.items}
              onOpenTerminal={openTerminal}
              onStopTerminal={terminals.stop}
            />
          }
          sidebarFooter={
            <WorkspaceSidebarFooter
              onOpenSettings={() => void window.doric.settings.open()}
            />
          }
          sidebarHeader={<WorkspaceSidebarHeader />}
        >
          <SidebarInset className="min-h-0">
            <ConversationTerminals
              terminal={
                manual && (
                  <ManualTerminalTabs
                    state={tabs}
                    threadId={manual.threadId}
                    terminals={terminals.items}
                  />
                )
              }
            >
              <ThreadPane>
                {selectedThread ? (
                  <Conversation
                    key={selectedThread.id}
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
            </ConversationTerminals>
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
