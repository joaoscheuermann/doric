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
} from 'desktop/ui/empty';
import { SidebarInset, SidebarProvider } from 'desktop/ui/sidebar';
import { Toaster } from 'desktop/ui/sonner';
import { TooltipProvider } from 'desktop/ui/tooltip';
import {
  type CSSProperties,
  createElement,
  StrictMode,
  useEffect,
  useSyncExternalStore,
} from 'react';

import { DeleteDialog } from '../components/molecules/delete-dialog.js';
import { ProjectPanel } from '../components/organisms/project-panel.js';
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
import { useRegionItems } from '../hooks/use-region-items.js';
import { useWorkspace } from '../hooks/use-workspace.js';
import { useWorkspaceTabs } from '../hooks/use-workspace-tabs.js';
import { layoutQueryClient } from '../queries/client.js';
import { layoutServices } from '../services/layout-services.js';
import { bottomStore } from '../stores/bottom.js';
import { panelStore } from '../stores/panel.js';

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
  const tabOwner =
    workspace.selectedThreadId ??
    (workspace.selectedProjectId
      ? `project:${workspace.selectedProjectId}`
      : undefined);
  const tabs = useWorkspaceTabs(tabOwner);
  const { actions } = workspace;
  // The sandbox panel starts open and keeps the reader's choice
  // (`layout.panel/v1`).
  const filesOpen = useSyncExternalStore(
    panelStore.subscribe,
    () => panelStore.getState().open,
  );
  const panelView = useSyncExternalStore(
    panelStore.subscribe,
    () => panelStore.getState().active,
  );
  const panel = panelStore.getState();
  const panelItems = useRegionItems('layout.panel');
  const bottomVisible = useSyncExternalStore(
    bottomStore.subscribe,
    () => bottomStore.getState().visible.size > 0,
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
          <ProjectPanel
            active={panelView}
            onActiveChange={panel.select}
            items={panelItems}
          />
        }
        filesOpen={filesOpen}
        fileViewer={
          tabs.items.length === 0 || !tabOwner ? undefined : (
            <WorkspaceTabs state={tabs} threadId={tabOwner} />
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
            onSelectProject={actions.selectProject}
            onSelectThread={actions.selectThread}
            path={selectedThreadPath}
            project={selectedProject}
          />
        }
        onFilesOpenChange={panel.setOpen}
        sidebar={
          <ProjectSidebar
            actions={sidebarActions}
            after={<Region name="layout.sidebar" />}
            model={model}
          />
        }
        sidebarFooter={<WorkspaceSidebarFooter onOpenSettings={openSettings} />}
        sidebarHeader={<WorkspaceSidebarHeader />}
      >
        <SidebarInset className="min-h-0">
          <ConversationTerminals
            bottom={bottomVisible && <Region name="layout.main.bottom" />}
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
