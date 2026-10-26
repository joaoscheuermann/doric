// The layout's client part (stage 9, §5.3): the host adapters, the window's
// Project watch and connection mirror, and the layout contracts. Since WP-10N
// the provisional features are gone: files, git, terminal, usage and
// resources draw their own region items. All of
// it is bound to the activation services, never to an element's (D9-17).

import {
  type Cleanup,
  type ClientContext,
  DoricConnectionV1,
  NavigationV1,
  UiV1,
} from 'bundle/contracts';

import { RuntimeV1 } from './api/host.js';
import { disposeProjectWatch, initProjectWatch } from './api/project-watch.js';
import { disposeWorkspaceApi, initWorkspaceApi } from './api/workspace-api.js';
import { tabOwnerOf } from './domain/route-selection.js';
import { threadsPane } from './domain/sidebar-stack.js';
import { LayoutWorkspaceElement } from './elements/workspace-element.js';
import { resetLayoutQueryClient } from './queries/client.js';
import { createLayoutDashboard } from './services/layout-dashboard.js';
import { createLayoutPanel } from './services/layout-panel.js';
import { setLayoutServices } from './services/layout-services.js';
import { createLayoutSidebar } from './services/layout-sidebar.js';
import { createLayoutStack } from './services/layout-stack.js';
import { createLayoutTabs } from './services/layout-tabs.js';
import { createLayoutWorkspace } from './services/layout-workspace.js';
import { watchThreadTabs } from './services/thread-tabs.js';
import { resetBottom } from './stores/bottom.js';
import { disposeConnection, initConnection } from './stores/connection.js';
import { resetDashboard } from './stores/dashboard.js';
import { resetPanel } from './stores/panel.js';
import { resetRouteSelection } from './stores/route-selection.js';
import { registerPane, resetStack } from './stores/stack.js';
import { resetThreadRows } from './stores/thread-rows.js';
import { workspaceStore } from './stores/workspace.js';

export function activate({ services }: ClientContext): Cleanup {
  setLayoutServices(services);
  initWorkspaceApi(services);

  const connection = services.use(DoricConnectionV1);
  initConnection(connection);
  initProjectWatch({ runtime: services.use(RuntimeV1), connection });

  // WP-10N: the footer's working directory and usage, the header's
  // new-terminal button and the panel's views are other bundles' region items
  // (git, usage, terminal, files, resources); the layout draws none itself.
  const ui = services.use(UiV1);
  const stopThreadTabs = watchThreadTabs(ui);
  ui.define('layout-workspace', LayoutWorkspaceElement);

  const navigation = services.use(NavigationV1);
  navigation.register({
    path: '/',
    create: () => ui.create('layout-workspace'),
  });
  for (const path of ['/projects', '/projects/:projectId']) {
    navigation.register({ path, create: () => ui.create('layout-workspace') });
  }
  services.provide(
    createLayoutTabs({
      ui,
      owner: () =>
        tabOwnerOf(
          navigation.current(),
          workspaceStore.getState().tree.selection.projectId,
        ),
      watchOwner: (listener) => {
        const route = navigation.subscribe(listener);
        const tree = workspaceStore.subscribe(listener);
        return () => {
          route.dispose();
          tree();
        };
      },
    }),
  );
  // WP-10P: the Project panel and the sidebar's Thread rows. The stack carries
  // the sidebar's groups: the layout's own Threads pane and whatever a bundle
  // registers (the `screen` views today).
  services.provide(createLayoutWorkspace());
  services.provide(createLayoutPanel());
  services.provide(createLayoutDashboard());
  services.provide(createLayoutSidebar());
  services.provide(createLayoutStack());
  const threadsRegistration = registerPane(threadsPane);

  return () => {
    stopThreadTabs();
    disposeProjectWatch();
    disposeConnection();
    disposeWorkspaceApi();
    resetRouteSelection();
    resetPanel();
    resetDashboard();
    resetBottom();
    threadsRegistration.dispose();
    resetStack();
    resetThreadRows();
    resetLayoutQueryClient();
    setLayoutServices(undefined);
  };
}
