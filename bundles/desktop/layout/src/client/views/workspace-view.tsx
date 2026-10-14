// `<layout-workspace>` (stage 9 §5.4): the old renderer's `views/app.tsx`
// with the same hooks and props. The conversation is the child route in the
// inner `<core-outlet>`, the content footer is the `layout.footer` region and
// the header's actions are the `layout.header` region. The `layout.overlay`
// region is the floating layer over the conversation area.

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
import { Tabs } from 'desktop/ui/tabs';
import { TooltipProvider } from 'desktop/ui/tooltip';
import {
  type CSSProperties,
  createElement,
  StrictMode,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';

import { DeleteDialog } from '../components/molecules/delete-dialog.js';
import { Dashboard } from '../components/organisms/dashboard.js';
import {
  ProjectPanel,
  ProjectPanelTabs,
} from '../components/organisms/project-panel.js';
import {
  ProjectSidebar,
  type SidebarActions,
  type SidebarModel,
} from '../components/organisms/project-sidebar.js';
import { ProjectTabBar } from '../components/organisms/project-tabs.js';
import { WorkspaceGlobalFooter } from '../components/organisms/workspace-footer.js';
import {
  WorkspaceTabBar,
  WorkspaceTabs,
} from '../components/organisms/workspace-tabs.js';
import { ConversationTerminals } from '../components/templates/conversation-terminals.js';
import { ThreadPane } from '../components/templates/thread-pane.js';
import { WorkspaceLayout } from '../components/templates/workspace-layout.js';
import { useProjectTabs } from '../hooks/use-project-tabs.js';
import { useRegionItems } from '../hooks/use-region-items.js';
import { useWorkspace } from '../hooks/use-workspace.js';
import { useWorkspaceTabs } from '../hooks/use-workspace-tabs.js';
import { layoutQueryClient } from '../queries/client.js';
import { layoutServices } from '../services/layout-services.js';
import { bottomStore } from '../stores/bottom.js';
import { panelStore } from '../stores/panel.js';
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
  const [newTab, setNewTab] = useState(false);
  const frame = useRef<HTMLDivElement>(null);
  const [focusRequest, setFocusRequest] = useState(0);
  useLayoutEffect(() => {
    if (focusRequest === 0) return;
    const content = frame.current?.querySelector<HTMLElement>(
      '[aria-label="Thread conversation"], main',
    );
    if (content) {
      content.tabIndex = -1;
      content.focus({ preventScroll: true });
    }
  }, [focusRequest]);
  const projectTabs = useProjectTabs(
    workspace.projects,
    !workspace.loadingProjects && workspace.error === undefined,
  );
  useEffect(() => {
    if (projectTabs.path !== '/') setNewTab(false);
  }, [projectTabs.path]);
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
  const openSettings = () => {
    void layoutServices()
      .use(CommandsV1)
      .execute(OPEN_SETTINGS, {})
      .catch((error: unknown) => {
        console.error('Doric: the settings window could not open:', error);
      });
  };

  const tabBar = (
    <ProjectTabBar
      trailing={projectTabs.path === '/' || projectTabs.path === '/projects'}
      state={projectTabs.state}
      path={projectTabs.path}
      projects={workspace.projects}
      navigate={(path) => {
        setNewTab(false);
        projectTabs.navigate(path);
        setFocusRequest((count) => count + 1);
      }}
      close={projectTabs.close}
      closeMany={projectTabs.closeMany}
      move={projectTabs.move}
      rename={(project, name) =>
        actions.rename({ kind: 'project', value: project }, name)
      }
      onNewProject={() => {
        projectTabs.navigate('/');
        setNewTab(true);
      }}
    />
  );
  if (projectTabs.path === '/' || projectTabs.path === '/projects') {
    return (
      <div
        ref={frame}
        className="flex h-svh min-h-0 flex-col bg-background text-foreground"
      >
        {tabBar}
        <Dashboard
          workspace={workspace}
          all={!newTab || projectTabs.path !== '/'}
          navigate={(path) => {
            setNewTab(false);
            projectTabs.navigate(path);
          }}
        />
        <WorkspaceGlobalFooter onOpenSettings={openSettings} />
        <DeleteDialog
          entity={workspace.deleting}
          pending={workspace.deletingPending}
          onDelete={actions.confirmDelete}
          onOpenChange={(open) => {
            if (!open) actions.dismissDelete();
          }}
        />
      </div>
    );
  }

  return (
    <div
      ref={frame}
      className="flex h-svh min-h-0 flex-col bg-background text-foreground"
    >
      <SidebarProvider
        style={panelWidth}
        className="min-h-0 flex-1 flex-col overflow-hidden"
      >
        <Tabs
          value={tabs.selected ?? ''}
          onValueChange={(id) => {
            if (tabOwner) workspaceTabsStore.getState().select(tabOwner, id);
          }}
          className="min-h-0 flex-1 gap-0"
        >
          <WorkspaceLayout
            header={tabBar}
            viewerTabs={
              tabs.items.length > 0 && tabOwner ? (
                <WorkspaceTabBar state={tabs} threadId={tabOwner} />
              ) : undefined
            }
            headerActions={
              <>
                <Region name="layout.header" />
                <ProjectPanelTabs
                  active={panelView}
                  onActiveChange={panel.show}
                  items={panelItems}
                />
              </>
            }
            files={<ProjectPanel active={panelView} items={panelItems} />}
            filesOpen={filesOpen}
            fileViewer={
              tabs.items.length === 0 || !tabOwner ? undefined : (
                <WorkspaceTabs state={tabs} />
              )
            }
            onFilesOpenChange={panel.setOpen}
            sidebar={
              <ProjectSidebar
                actions={sidebarActions}
                after={<Region name="layout.sidebar" />}
                model={model}
              />
            }
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
                        <EmptyTitle>
                          {selectedProject?.name ?? 'No project selected'}
                        </EmptyTitle>
                        <EmptyDescription>
                          Start a thread or select one from the sidebar.
                        </EmptyDescription>
                      </EmptyHeader>
                      {selectedProject && (
                        <button
                          type="button"
                          className="dashboard-new"
                          onClick={() =>
                            actions.beginThread(selectedProject.id)
                          }
                        >
                          New thread
                        </button>
                      )}
                    </Empty>
                  )}
                </ThreadPane>
              </ConversationTerminals>
              <footer
                data-slot="workspace-footer"
                className="flex chrome-bar shrink-0 items-center justify-end gap-1 px-2 text-[11px] font-light text-muted-foreground"
              >
                <Region name="layout.footer" />
              </footer>
              {/*
                The floating layer over the conversation area: `layout.overlay`
                items place themselves, and the layer itself never intercepts
                a pointer.
              */}
              <div
                data-slot="workspace-overlay"
                className="pointer-events-none absolute inset-0 z-20"
              >
                <Region name="layout.overlay" />
              </div>
            </SidebarInset>
          </WorkspaceLayout>
        </Tabs>
        <DeleteDialog
          entity={workspace.deleting}
          pending={workspace.deletingPending}
          onDelete={actions.confirmDelete}
          onOpenChange={(open) => {
            if (!open) actions.dismissDelete();
          }}
        />
      </SidebarProvider>
      <WorkspaceGlobalFooter onOpenSettings={openSettings} />
    </div>
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
