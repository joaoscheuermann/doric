// The navigation's four slot elements (bundle isolation 4(a), decision O2;
// `workspace` since 4(c)): the workspace fills the shell's slots with them.
// Each one is a React root of its own, so what they share lives in stores
// (decision O1): the workspace's once-per-window effects run only in
// `workspace-sidebar`, which both forms draw; the Project tabs live in
// `stores/project-tabs.ts`; the Dashboard's search and create form in
// `stores/dashboard.ts`.

import { QueryClientProvider } from '@tanstack/react-query';
import { NavigationV1 } from 'bundle/contracts';
import { defineReactElement } from 'desktop/ui/react-element';
import { SidebarScope } from 'desktop/ui/sidebar';
import { TooltipProvider } from 'desktop/ui/tooltip';
import type {
  SHELL_HEADER_ACTIONS,
  SHELL_WINDOW_ACTIONS,
} from 'layout/contracts';
import {
  createElement,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useSyncExternalStore,
} from 'react';
import { useStore } from 'zustand/react';

import { DeleteDialog } from '../components/molecules/delete-dialog.js';
import {
  DashboardContent,
  DashboardNavigation,
} from '../components/organisms/dashboard.js';
import { DashboardSidebarFooter } from '../components/organisms/dashboard-sidebar.js';
import {
  ProjectSidebar,
  type SidebarActions,
  type SidebarModel,
} from '../components/organisms/project-sidebar.js';
import { ProjectTabBar } from '../components/organisms/project-tabs.js';
import { SidebarHeader } from '../components/organisms/sidebar-header.js';
import { descendantsInChat, isArchived } from '../domain/thread-archive.js';
import { useProjectTabs } from '../hooks/use-project-tabs.js';
import { useWorkspace } from '../hooks/use-workspace.js';
import { workspaceQueryClient } from '../queries/client.js';
import { workspaceServices } from '../services/workspace-services.js';
import { newTabStore } from '../stores/new-tab.js';

/** The workspace's query client and tooltips, which every element root needs. */
export function WorkspaceProviders({
  children,
}: {
  readonly children?: ReactNode;
}) {
  return (
    <QueryClientProvider client={workspaceQueryClient()}>
      <TooltipProvider>{children}</TooltipProvider>
    </QueryClientProvider>
  );
}

const wrap = () => WorkspaceProviders;

/** Marks `/` as opened through "New project", or clears that mark. */
const setNewTab = (open: boolean) => newTabStore.getState().set(open);

/**
 * Moves the focus to what a navigation opened: the Thread's conversation,
 * else the first `main`. It waits a frame, because the frame and the
 * conversation are other roots that draw the new route on their own.
 */
const focusContent = (): void => {
  requestAnimationFrame(() => {
    const content = document.querySelector<HTMLElement>(
      '[aria-label="Thread conversation"], main',
    );
    if (content) {
      content.tabIndex = -1;
      content.focus({ preventScroll: true });
    }
  });
};

/** The window's path, re-read on every navigation. */
const useRoutePath = (): string => {
  const navigation = useMemo(() => workspaceServices().use(NavigationV1), []);
  const subscribe = useCallback(
    (listener: () => void) => {
      const subscription = navigation.subscribe(listener);
      return () => subscription.dispose();
    },
    [navigation],
  );
  const read = () => navigation.current()?.path ?? '/';
  return useSyncExternalStore(subscribe, read, read);
};

const isDashboard = (path: string): boolean =>
  path === '/' || path === '/projects';

/**
 * Whether the Dashboard shows its list: everywhere but `/` reached through
 * "New project", which shows the home body.
 */
const useDashboardList = (path: string): boolean => {
  const newTab = useStore(newTabStore, (state) => state.open);
  return !(newTab && path === '/');
};

/** Leaves the "New project" mark and goes to `path`. */
const navigateTo = (path: string): void => {
  setNewTab(false);
  workspaceServices().use(NavigationV1).navigate(path);
};

/**
 * `workspace-sidebar` (`shell.sidebar`): the Dashboard's sidebar on `/` and
 * `/projects`, the Project sidebar's header, search and Thread region
 * elsewhere, and the delete dialog. It alone runs the workspace's
 * once-per-window effects.
 */
function NavigationSidebar() {
  const workspace = useWorkspace({ effects: true });
  const path = useRoutePath();
  const all = useDashboardList(path);
  const { actions, deleting } = workspace;
  // U16: deleting an archived Thread names its descendants still in Chat.
  const inChat =
    deleting?.kind === 'thread' && isArchived(deleting.value)
      ? descendantsInChat(
          workspace.threadsByProject[deleting.value.projectId] ?? [],
          deleting.value.id,
        )
      : 0;
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
    archiveThread: actions.archiveThread,
    beginProject: actions.beginProject,
    beginThread: actions.beginThread,
    cancelDraft: actions.cancelDraft,
    cancelRename: actions.cancelRename,
    copyThreadId: actions.copyThreadId,
    createProject: actions.createProject,
    createThread: actions.createThread,
    deleteEntity: actions.requestDelete,
    rename: actions.rename,
    restoreThread: actions.restoreThread,
    retryError: actions.retryError,
    selectProject: actions.selectProject,
    selectThread: actions.selectThread,
    setProjectColor: actions.setProjectColor,
    setThreadPinned: actions.setThreadPinned,
    startRename: actions.startRename,
  };

  return (
    <SidebarScope>
      {isDashboard(path) ? (
        <DashboardNavigation
          workspace={workspace}
          all={all}
          navigate={navigateTo}
        />
      ) : (
        <ProjectSidebar
          header={
            <SidebarHeader
              onDashboard={() => {
                navigateTo('/projects');
                focusContent();
              }}
            />
          }
          actions={sidebarActions}
          model={model}
        />
      )}
      <DeleteDialog
        entity={workspace.deleting}
        inChat={inChat}
        pending={workspace.deletingPending}
        onDelete={actions.confirmDelete}
        onOpenChange={(open) => {
          if (!open) actions.dismissDelete();
        }}
      />
    </SidebarScope>
  );
}

/**
 * `workspace-sidebar-footer` (`shell.sidebar.footer` on `/` and `/projects`):
 * the `workspace.dashboard.footer` items.
 */
function NavigationSidebarFooter() {
  return (
    <SidebarScope>
      <DashboardSidebarFooter />
    </SidebarScope>
  );
}

/**
 * `workspace-project-tabs` (`shell.titlebar.tabs`): the Project tab bar. Its
 * end holds the window's actions on the Dashboard's routes (the page form) and
 * the `shell.header.actions` items elsewhere (decision O1).
 */
function NavigationProjectTabs() {
  const workspace = useWorkspace();
  const projectTabs = useProjectTabs(
    workspace.projects,
    !workspace.loadingProjects && workspace.error === undefined,
  );
  const path = useRoutePath();
  const { actions } = workspace;
  useEffect(() => {
    if (projectTabs.path !== '/') setNewTab(false);
  }, [projectTabs.path]);
  const end = isDashboard(path)
    ? ('shell.window.actions' satisfies typeof SHELL_WINDOW_ACTIONS)
    : ('shell.header.actions' satisfies typeof SHELL_HEADER_ACTIONS);

  return (
    <ProjectTabBar
      actions={createElement('core-region', { key: end, name: end })}
      state={projectTabs.state}
      path={projectTabs.path}
      projects={workspace.projects}
      navigate={(path) => {
        setNewTab(false);
        projectTabs.navigate(path);
        focusContent();
      }}
      close={projectTabs.close}
      closeMany={projectTabs.closeMany}
      move={projectTabs.move}
      rename={(project, name) =>
        actions.rename({ kind: 'project', value: project }, name)
      }
      onNewThread={(project) => {
        setNewTab(false);
        // After the tab's menu has closed: the draft row is drawn by
        // `workspace-sidebar`, another root, and must take the focus after the
        // menu has handed it back.
        queueMicrotask(() => actions.beginThread(project.id));
      }}
      setColor={actions.setProjectColor}
      onNewProject={() => {
        projectTabs.navigate('/');
        setNewTab(true);
      }}
    />
  );
}

/** `workspace-dashboard` (`shell.page` on `/` and `/projects`): the Dashboard's content. */
function NavigationDashboard() {
  const workspace = useWorkspace();
  const all = useDashboardList(useRoutePath());
  return (
    <DashboardContent workspace={workspace} all={all} navigate={navigateTo} />
  );
}

export const WorkspaceSidebarElement = defineReactElement({
  props: [],
  wrap,
  render: NavigationSidebar,
});

export const WorkspaceSidebarFooterElement = defineReactElement({
  props: [],
  wrap,
  render: NavigationSidebarFooter,
});

export const WorkspaceProjectTabsElement = defineReactElement({
  props: [],
  wrap,
  render: NavigationProjectTabs,
});

export const WorkspaceDashboardElement = defineReactElement({
  props: [],
  wrap,
  render: NavigationDashboard,
});
