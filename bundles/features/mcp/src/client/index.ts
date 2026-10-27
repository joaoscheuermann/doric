// The mcp bundle's client part: the sidebar's MCP pane over `mcp/v1`.
// Registering the pane in the layout's stack (`layout.stack/v1`) is what makes
// the group appear; its rows are the servers of the Project the workspace
// selects, and the group's add control is an element of its own.
//
// The watch is the activation's (D9-17): it follows the selection, so one
// watch is open at a time, for the selected Project, and none while no Project
// is selected.

import {
  type Cleanup,
  type ClientContext,
  type Disposable,
  UiV1,
} from 'bundle/contracts';

import { createMcpApi } from './api.js';
import {
  defineMcpElements,
  MCP_GROUP_ACTION_TAG,
  MCP_SIDEBAR_TAG,
} from './elements.js';
import { LayoutStackV1, LayoutWorkspaceV1, type StackPane } from './peers.js';
import { createMcpSignIns } from './sign-in.js';
import { createMcpServersStore } from './store.js';

/**
 * The sidebar's MCP group: the servers of the current Project, below the
 * Screens group. It starts collapsed, so the sidebar opens with the tree
 * alone, and expands to its minimum size.
 */
export const mcpPane: StackPane = {
  id: 'mcp-sidebar',
  order: 20,
  title: 'MCP',
  tag: MCP_SIDEBAR_TAG,
  headerTag: MCP_GROUP_ACTION_TAG,
  collapsible: true,
  initiallyOpen: false,
  minSize: '20%',
  maxSize: '80%',
};

export function activate({ services }: ClientContext): Cleanup {
  const store = createMcpServersStore();
  const api = createMcpApi(services);
  const ui = services.use(UiV1);
  const signIns = createMcpSignIns({ store, api });
  const elements = defineMcpElements({ store, api, signIns });
  const element = ui.define(MCP_SIDEBAR_TAG, elements.sidebar);
  const actionElement = ui.define(MCP_GROUP_ACTION_TAG, elements.groupAction);

  // The layout may not be active yet (or at all, in a composition without it),
  // so the pane is registered whenever the stack appears.
  const pane: Disposable = services.whenAvailable(LayoutStackV1, (stack) => {
    const registration = stack.register(mcpPane);
    return () => registration.dispose();
  });

  // The selection is read as the Project's id, a primitive: the layout builds
  // a new record on every read. A new Project replaces the watch.
  const following: Disposable = services.whenAvailable(
    LayoutWorkspaceV1,
    (workspace) => {
      let watching: Disposable | undefined;

      const follow = (): void => {
        const projectId = workspace.selection().project?.id;
        if (projectId === store.projectId() && watching !== undefined) return;
        watching?.dispose();
        watching = undefined;
        store.select(projectId);
        if (projectId === undefined) return;
        watching = api.watch(projectId, {
          servers: (servers) => store.setServers(servers),
          failed: (message) => store.setFailure(message),
        });
      };

      const selection = workspace.subscribe(follow);
      follow();

      return () => {
        selection.dispose();
        watching?.dispose();
        store.select(undefined);
      };
    },
  );

  return () => {
    following.dispose();
    signIns.dispose();
    pane.dispose();
    element.dispose();
    actionElement.dispose();
  };
}
