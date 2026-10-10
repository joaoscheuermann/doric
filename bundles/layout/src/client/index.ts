// The layout's client part (stage 9, §5.3): the host adapters, the window's
// Project watch and connection mirror, and the two layout contracts. All of
// it is bound to the activation services, never to an element's (D9-17).

import {
  type Cleanup,
  type ClientContext,
  DoricConnectionV1,
  HooksV1,
  NavigationV1,
  RegionsV1,
  UiV1,
} from 'bundle/contracts';

import { ChatHooksV1 } from './api/chat-hooks.js';
import { RuntimeV1 } from './api/host.js';
import { disposeProjectWatch, initProjectWatch } from './api/project-watch.js';
import { disposeWorkspaceApi, initWorkspaceApi } from './api/workspace-api.js';
import { tabOwnerOf } from './domain/route-selection.js';
import { LayoutWorkspaceElement } from './elements/workspace-element.js';
import {
  cwdHosts,
  disposeProvisional,
  initProvisional,
  newTerminalHosts,
  usageHosts,
} from './provisional/index.js';
import { layoutQueryClient, resetLayoutQueryClient } from './queries/client.js';
import { refreshProject } from './queries/project-refresh.js';
import { setLayoutServices } from './services/layout-services.js';
import { createLayoutTabs } from './services/layout-tabs.js';
import { createLayoutWorkspace } from './services/layout-workspace.js';
import { disposeConnection, initConnection } from './stores/connection.js';
import { resetRouteSelection } from './stores/route-selection.js';
import { workspaceStore } from './stores/workspace.js';

export function activate({ services }: ClientContext): Cleanup {
  setLayoutServices(services);
  initWorkspaceApi(services);

  const connection = services.use(DoricConnectionV1);
  initConnection(connection);
  initProjectWatch({ runtime: services.use(RuntimeV1), connection });
  initProvisional(services);

  // The layout's own region items (§5.3), rendered by the workspace view's
  // portals: the footer's working directory (10) and usage (30), and the
  // header's new-terminal button (10).
  const ui = services.use(UiV1);
  ui.define('layout-workspace', LayoutWorkspaceElement);
  ui.define('layout-cwd', cwdHosts.Element);
  ui.define('layout-thread-usage', usageHosts.Element);
  ui.define('layout-new-terminal', newTerminalHosts.Element);
  const regions = services.use(RegionsV1);
  regions.add('layout.footer', { id: 'cwd', tag: 'layout-cwd', order: 10 });
  regions.add('layout.footer', {
    id: 'usage',
    tag: 'layout-thread-usage',
    order: 30,
  });
  regions.add('layout.header', {
    id: 'new-terminal',
    tag: 'layout-new-terminal',
    order: 10,
  });

  const navigation = services.use(NavigationV1);
  navigation.register({
    path: '/',
    create: () => ui.create('layout-workspace'),
  });
  // D9-10: a sandbox-writing tool in any held conversation refreshes its Project.
  const activity = services.use(HooksV1).whenAvailable(ChatHooksV1, (chat) => {
    chat.onSandboxActivityHook(({ projectId }) => {
      void refreshProject(layoutQueryClient(), projectId);
    });
  });
  services.provide(
    createLayoutTabs({
      ui,
      owner: () =>
        tabOwnerOf(
          navigation.current(),
          workspaceStore.getState().tree.selection.projectId,
        ),
    }),
  );
  services.provide(createLayoutWorkspace());

  return () => {
    activity.dispose();
    disposeProvisional();
    disposeProjectWatch();
    disposeConnection();
    disposeWorkspaceApi();
    resetRouteSelection();
    resetLayoutQueryClient();
    setLayoutServices(undefined);
  };
}
