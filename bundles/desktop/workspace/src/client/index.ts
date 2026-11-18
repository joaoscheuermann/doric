// The workspace's client part (bundle isolation 4(c)): the navigation the
// shell's slots draw — the sidebar, the Project tabs, the Dashboard and its
// footer — bound to the window's records mirror (`runtime.records/v1`), the
// Project routes, the tab owner the shell's tabs follow, and the workspace's
// contracts. All of it is bound to the activation services, never to an
// element's (D9-17).

import {
  type Cleanup,
  type ClientContext,
  type Disposable,
  HooksV1,
  NavigationV1,
  RegionsV1,
  UiV1,
} from 'bundle/contracts';
import {
  LayoutTabsV2,
  type SHELL_PAGE,
  type SHELL_SIDEBAR,
  type SHELL_SIDEBAR_FOOTER,
  type SHELL_TITLEBAR_TABS,
} from 'layout/contracts';
import { RuntimeRecordsV1 } from 'runtime/contracts';

import {
  LayoutDashboardV1,
  LayoutSidebarV1,
  WorkspaceDashboardV1,
  WorkspaceHooksV1,
  WorkspaceSidebarV1,
} from '../contracts/index.js';
import {
  PROJECT_ROUTE,
  PROJECTS_ROUTE,
  tabOwnerOf,
} from './domain/route-selection.js';
import {
  WorkspaceDashboardElement,
  WorkspaceProjectTabsElement,
  WorkspaceSidebarElement,
  WorkspaceSidebarFooterElement,
} from './elements/navigation-elements.js';
import {
  WorkspaceProjectEmptyElement,
  WorkspaceProjectsRouteElement,
} from './elements/project-empty-element.js';
import { setOpenThreadHook } from './hooks/thread-navigation.js';
import { resetFooterReports } from './hooks/use-footer-items.js';
import { resetWorkspaceQueryClient } from './queries/client.js';
import { createWorkspaceDashboard } from './services/workspace-dashboard.js';
import { createWorkspaceSelection } from './services/workspace-selection.js';
import { setWorkspaceServices } from './services/workspace-services.js';
import { createWorkspaceSidebar } from './services/workspace-sidebar.js';
import { createLayoutWorkspace } from './services/workspace-workspace.js';
import { resetDashboard } from './stores/dashboard.js';
import { resetNewTab } from './stores/new-tab.js';
import { restoreProjectTabs } from './stores/project-tabs.js';
import { resetRouteSelection } from './stores/route-selection.js';
import { resetThreadRows } from './stores/thread-rows.js';
import { bindRecords, workspaceStore } from './stores/workspace.js';

export function activate({ services }: ClientContext): Cleanup {
  setWorkspaceServices(services);
  setOpenThreadHook(services.use(HooksV1).define(WorkspaceHooksV1));
  const records = services.whenAvailable(RuntimeRecordsV1, (mirror) => {
    bindRecords(mirror);
    return () => bindRecords(undefined);
  });

  const ui = services.use(UiV1);
  ui.define('workspace-sidebar', WorkspaceSidebarElement);
  ui.define('workspace-sidebar-footer', WorkspaceSidebarFooterElement);
  ui.define('workspace-project-tabs', WorkspaceProjectTabsElement);
  ui.define('workspace-dashboard', WorkspaceDashboardElement);
  ui.define('workspace-project-empty', WorkspaceProjectEmptyElement);
  ui.define('workspace-projects-route', WorkspaceProjectsRouteElement);
  restoreProjectTabs();

  const navigation = services.use(NavigationV1);
  const routes = [
    navigation.register({
      path: PROJECTS_ROUTE,
      parent: '/',
      create: () => ui.create('workspace-projects-route'),
    }),
    navigation.register({
      path: PROJECT_ROUTE,
      parent: '/',
      create: (match) => ui.create('workspace-project-empty', match.params),
    }),
  ];
  // The navigation's slot items (decision O2): the sidebar and the Project
  // tabs in every window; the Dashboard and its footer while the route is `/`
  // or `/projects`, which puts the frame in the page form.
  const regions = services.use(RegionsV1);
  const slots = [
    regions.add('shell.sidebar' satisfies typeof SHELL_SIDEBAR, {
      id: 'navigation',
      tag: 'workspace-sidebar',
    }),
    regions.add('shell.titlebar.tabs' satisfies typeof SHELL_TITLEBAR_TABS, {
      id: 'project-tabs',
      tag: 'workspace-project-tabs',
    }),
  ];
  let dashboard: readonly Disposable[] = [];
  const followDashboard = () => {
    const path = navigation.current()?.path;
    const onDashboard = path === '/' || path === PROJECTS_ROUTE;
    if (onDashboard === dashboard.length > 0) return;
    if (!onDashboard) {
      for (const item of dashboard) item.dispose();
      dashboard = [];
      return;
    }
    dashboard = [
      regions.add('shell.page' satisfies typeof SHELL_PAGE, {
        id: 'dashboard',
        tag: 'workspace-dashboard',
      }),
      regions.add(
        'shell.sidebar.footer' satisfies typeof SHELL_SIDEBAR_FOOTER,
        {
          id: 'dashboard-footer',
          tag: 'workspace-sidebar-footer',
        },
      ),
    ];
  };
  followDashboard();
  const dashboardRoute = navigation.subscribe(followDashboard);
  // The tab owner (bundle isolation 4a): the route's Thread, else the
  // selected Project, named to the shell's tabs whenever the key changes.
  const tabs = services.use(LayoutTabsV2);
  let owner: { readonly key: string | undefined } | undefined;
  const followOwner = () => {
    const key = tabOwnerOf(
      navigation.current(),
      workspaceStore.getState().tree.selection.projectId,
    );
    if (owner !== undefined && owner.key === key) return;
    owner = { key };
    tabs.setOwner(key === undefined ? {} : { owner: key });
  };
  followOwner();
  const ownerRoute = navigation.subscribe(followOwner);
  const ownerTree = workspaceStore.subscribe(followOwner);

  services.provide(createWorkspaceSelection());
  services.provide(createWorkspaceSidebar(WorkspaceSidebarV1));
  services.provide(createWorkspaceDashboard(WorkspaceDashboardV1));
  // The transition (until step 4(e)): the three ids the layout provided.
  services.provide(createLayoutWorkspace());
  services.provide(createWorkspaceSidebar(LayoutSidebarV1));
  services.provide(createWorkspaceDashboard(LayoutDashboardV1));

  return () => {
    dashboardRoute.dispose();
    for (const item of [...dashboard, ...slots, ...routes]) item.dispose();
    ownerRoute.dispose();
    ownerTree();
    records.dispose();
    resetRouteSelection();
    resetDashboard();
    resetNewTab();
    resetThreadRows();
    resetWorkspaceQueryClient();
    resetFooterReports();
    setOpenThreadHook(undefined);
    setWorkspaceServices(undefined);
  };
}
