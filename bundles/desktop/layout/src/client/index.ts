// The layout's client part (stage 9, §5.3): the workspace bound to the
// window's records mirror (`runtime.records/v1`, bundle isolation phase 3),
// and the layout contracts. Since WP-10N
// the provisional features are gone: files, git, terminal, usage and
// resources draw their own region items. All of
// it is bound to the activation services, never to an element's (D9-17).

import {
  type Cleanup,
  type ClientContext,
  type Disposable,
  NavigationV1,
  RegionsV1,
  UiV1,
} from 'bundle/contracts';

import {
  SHELL_PAGE,
  SHELL_SIDEBAR,
  SHELL_SIDEBAR_FOOTER,
  SHELL_TITLEBAR_TABS,
  SHELL_WINDOW_ACTIONS,
} from '../contracts/index.js';
import { followAbout } from './domain/about.js';
import {
  PROJECT_ROUTE,
  PROJECTS_ROUTE,
  tabOwnerOf,
} from './domain/route-selection.js';
import { RecordsV1 } from './domain/workspace.js';
import {
  LayoutAccountStatusElement,
  LayoutDashboardElement,
  LayoutProjectTabsElement,
  LayoutSidebarElement,
  LayoutSidebarFooterElement,
} from './elements/navigation-elements.js';
import {
  LayoutProjectEmptyElement,
  LayoutProjectsRouteElement,
} from './elements/project-empty-element.js';
import { LayoutWorkspaceElement } from './elements/workspace-element.js';
import { resetLayoutQueryClient } from './queries/client.js';
import { createLayoutConversation } from './services/layout-conversation.js';
import { createLayoutDashboard } from './services/layout-dashboard.js';
import { createLayoutPanelV3 } from './services/layout-panel.js';
import { setLayoutServices } from './services/layout-services.js';
import { createLayoutSidebar } from './services/layout-sidebar.js';
import { createLayoutStack } from './services/layout-stack.js';
import { createLayoutTabs } from './services/layout-tabs.js';
import { createLayoutWorkspace } from './services/layout-workspace.js';
import { watchThreadTabs } from './services/thread-tabs.js';
import { watchThreadViews } from './services/thread-views.js';
import { resetBottom } from './stores/bottom.js';
import { resetDashboard } from './stores/dashboard.js';
import { resetNewTab } from './stores/new-tab.js';
import { resetPanel } from './stores/panel.js';
import { restoreProjectTabs } from './stores/project-tabs.js';
import { resetRouteSelection } from './stores/route-selection.js';
import { resetStack } from './stores/stack.js';
import { resetThreadRows } from './stores/thread-rows.js';
import { bindRecords, workspaceStore } from './stores/workspace.js';
import { workspaceTabsStore } from './stores/workspace-tabs.js';

export function activate({ services }: ClientContext): Cleanup {
  setLayoutServices(services);
  const records = services.whenAvailable(RecordsV1, (mirror) => {
    bindRecords(mirror);
    return () => bindRecords(undefined);
  });
  const about = followAbout(services);

  // WP-10N: the footer's working directory and usage, the header's
  // new-terminal button and the panel's views are other bundles' region items
  // (git, usage, terminal, files, resources); the layout draws none itself.
  const ui = services.use(UiV1);
  const stopThreadTabs = watchThreadTabs(ui);
  const stopThreadViews = watchThreadViews(services);
  ui.define('layout-workspace', LayoutWorkspaceElement);
  ui.define('layout-projects-route', LayoutProjectsRouteElement);
  ui.define('layout-project-empty', LayoutProjectEmptyElement);
  ui.define('layout-sidebar', LayoutSidebarElement);
  ui.define('layout-sidebar-footer', LayoutSidebarFooterElement);
  ui.define('layout-project-tabs', LayoutProjectTabsElement);
  ui.define('layout-dashboard', LayoutDashboardElement);
  ui.define('layout-account-status', LayoutAccountStatusElement);
  restoreProjectTabs();

  const navigation = services.use(NavigationV1);
  navigation.register({
    path: '/',
    create: () => ui.create('layout-workspace'),
  });
  navigation.register({
    path: PROJECTS_ROUTE,
    parent: '/',
    create: () => ui.create('layout-projects-route'),
  });
  navigation.register({
    path: PROJECT_ROUTE,
    parent: '/',
    create: (match) => ui.create('layout-project-empty', match.params),
  });
  // The navigation's slot items (decision O2): the sidebar, the Project tabs
  // and the account in every window; the Dashboard and its footer while the
  // route is `/` or `/projects`, which puts the frame in the page form.
  const regions = services.use(RegionsV1);
  const slots = [
    regions.add(SHELL_SIDEBAR, { id: 'navigation', tag: 'layout-sidebar' }),
    regions.add(SHELL_TITLEBAR_TABS, {
      id: 'project-tabs',
      tag: 'layout-project-tabs',
    }),
    regions.add(SHELL_WINDOW_ACTIONS, {
      id: 'account',
      tag: 'layout-account-status',
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
      regions.add(SHELL_PAGE, { id: 'dashboard', tag: 'layout-dashboard' }),
      regions.add(SHELL_SIDEBAR_FOOTER, {
        id: 'settings',
        tag: 'layout-sidebar-footer',
      }),
    ];
  };
  followDashboard();
  const dashboardRoute = navigation.subscribe(followDashboard);
  // The tab owner (bundle isolation 4a): the route's Thread, else the
  // selected Project, pushed into the tabs store the tab service reads.
  const followOwner = () =>
    workspaceTabsStore
      .getState()
      .setOwner(
        tabOwnerOf(
          navigation.current(),
          workspaceStore.getState().tree.selection.projectId,
        ),
      );
  followOwner();
  const ownerRoute = navigation.subscribe(followOwner);
  const ownerTree = workspaceStore.subscribe(followOwner);
  services.provide(createLayoutTabs({ ui }));
  // WP-10P: the Project panel and the sidebar's Thread rows. The stack carries
  // the groups bundles register under the sidebar's Thread region (the
  // Screens and MCP panes today).
  services.provide(createLayoutWorkspace());
  services.provide(createLayoutPanelV3());
  services.provide(createLayoutConversation());
  services.provide(createLayoutDashboard());
  services.provide(createLayoutSidebar());
  services.provide(createLayoutStack());

  return () => {
    dashboardRoute.dispose();
    for (const item of [...dashboard, ...slots]) item.dispose();
    ownerRoute.dispose();
    ownerTree();
    stopThreadTabs();
    stopThreadViews();
    records.dispose();
    about.dispose();
    resetRouteSelection();
    resetPanel();
    resetDashboard();
    resetNewTab();
    resetBottom();
    resetStack();
    resetThreadRows();
    resetLayoutQueryClient();
    setLayoutServices(undefined);
  };
}
