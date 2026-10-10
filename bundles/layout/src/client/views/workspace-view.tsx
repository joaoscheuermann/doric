// `<layout-workspace>` (stage 9 §5.4): the old renderer's `views/app.tsx`
// with the same hooks and props. The conversation is the child route in the
// inner `<core-outlet>`, the content footer is the `layout.footer` region and
// the header's actions are the `layout.header` region.

import { QueryClientProvider } from '@tanstack/react-query';
import { CommandsV1 } from 'bundle/contracts';
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from 'desktop-ui/empty';
import { SidebarInset, SidebarProvider } from 'desktop-ui/sidebar';
import { Toaster } from 'desktop-ui/sonner';
import { TooltipProvider } from 'desktop-ui/tooltip';
import {
  type CSSProperties,
  createElement,
  StrictMode,
  useCallback,
  useEffect,
  useState,
} from 'react';

import { DeleteDialog } from '../components/molecules/delete-dialog.js';
import {
  ProjectSidebar,
  type SidebarActions,
  type SidebarModel,
} from '../components/organisms/project-sidebar.js';
import { WorkspaceSidebarFooter } from '../components/organisms/workspace-footer.js';
import {
  WorkspaceHeader,
  WorkspaceSidebarHeader,
} from '../components/organisms/workspace-header.js';
import { WorkspaceTabs } from '../components/organisms/workspace-tabs.js';
import { ConversationTerminals } from '../components/templates/conversation-terminals.js';
import { ThreadPane } from '../components/templates/thread-pane.js';
import { WorkspaceLayout } from '../components/templates/workspace-layout.js';
import { threadPath } from '../domain/thread-tree.js';
import { useProjectRefresh } from '../hooks/use-project-refresh.js';
import { useWorkspace } from '../hooks/use-workspace.js';
import { useWorkspaceTabs } from '../hooks/use-workspace-tabs.js';
import { ProjectFilesSidebar } from '../provisional/files/components/project-files-sidebar.js';
import { joinPath } from '../provisional/files/domain/files.js';
import type { ProjectChange } from '../provisional/files/domain/project-files.js';
import { useProjectFiles } from '../provisional/files/hooks/use-project-files.js';
import { ProvisionalPortals } from '../provisional/index.js';
import { ManualTerminalTabs } from '../provisional/terminals/components/manual-terminal-tabs.js';
import type { Terminal } from '../provisional/terminals/domain/terminals.js';
import { useTerminals } from '../provisional/terminals/hooks/use-terminals.js';
import { layoutQueryClient } from '../queries/client.js';
import { layoutServices } from '../services/layout-services.js';
import { workspaceTabsStore } from '../stores/workspace-tabs.js';

/** The panel owns the sidebar width, so the sidebar fills whatever it drags to. */
const panelWidth = {
  '--sidebar-width': '100%',
} as CSSProperties;

/** The core's open-settings command (forwarded to desktopMain, D9-8). */
const OPEN_SETTINGS = 'core.open-settings/v1';

/** A `<core-region name>`: `display: contents`, no role of its own. */
const Region = ({ name }: { readonly name: string }) =>
  createElement('core-region', { name });

function Workspace() {
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
  const openSettings = () => {
    void layoutServices()
      .use(CommandsV1)
      .execute(OPEN_SETTINGS, {})
      .catch((error: unknown) => {
        console.error('Doric: the settings window could not open:', error);
      });
  };

  return (
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
          <footer
            data-slot="workspace-footer"
            className="flex chrome-bar shrink-0 items-center justify-end gap-1 border-t bg-sidebar px-2 text-xs"
          >
            <Region name="layout.footer" />
          </footer>
        }
        header={
          <WorkspaceHeader
            actions={<Region name="layout.header" />}
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
            after={<Region name="layout.sidebar" />}
            model={model}
            terminals={terminals.items}
            onOpenTerminal={openTerminal}
            onStopTerminal={terminals.stop}
          />
        }
        sidebarFooter={<WorkspaceSidebarFooter onOpenSettings={openSettings} />}
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
                createElement('core-outlet')
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
      <ProvisionalPortals
        thread={selectedThread}
        changes={files.changes}
        onShowChanges={() => {
          setFilesView('changes');
          setFilesOpen(true);
        }}
        onNewTerminal={
          selectedThread
            ? () => void terminals.create(selectedThread.id)
            : undefined
        }
      />
    </SidebarProvider>
  );
}

/** The workspace window's frame, with the window's only toaster. */
export function WorkspaceView() {
  useEffect(() => {
    document.title = 'Doric';
  }, []);
  return (
    <StrictMode>
      <QueryClientProvider client={layoutQueryClient()}>
        <TooltipProvider>
          <Workspace />
          <Toaster />
        </TooltipProvider>
      </QueryClientProvider>
    </StrictMode>
  );
}
