// The terminal bundle's client part (stage 10, §3.10): the window's terminal
// store over `terminal/v1`, and the four elements — the header's "New
// terminal" button, the sidebar's terminal rows, the manual terminals of the
// bottom section and the agent terminal tab. All of it is bound to the
// activation services, never to an element's (D9-17).
//
// The header and bottom region items and the sidebar rows are registered by
// `registerTerminalSurfaces` while the layout serves `layout.sidebar/v1`,
// since WP-10N removed the layout's provisional terminals.

import {
  type Cleanup,
  type ClientContext,
  type Disposable,
  DoricConnectionV1,
  NavigationV1,
  type RegionItem,
  type Regions,
  RegionsV1,
  type Services,
  UiV1,
} from 'bundle/contracts';
import { toast } from 'desktop/ui/sonner';

import { TerminalServiceV1 } from '../contracts/index.js';
import { createTerminalApi } from './api.js';
import type { Terminal } from './domain/terminals.js';
import {
  defineTerminalElements,
  TERMINAL_VIEW_TAG,
  type TerminalClient,
} from './elements.js';
import { createTerminalWatches } from './output-watch.js';
import {
  FilesRefreshV1,
  type LayoutSidebar,
  LayoutSidebarV1,
  LayoutTabsV1,
  type LayoutWorkspace,
  LayoutWorkspaceV1,
} from './peers.js';
import { createTerminalStore, type TerminalStore } from './store.js';

/** The bottom section item the manual terminals are drawn in. */
export const MANUAL_ITEM_ID = 'terminal-manual';

/** The region items of the header button and the manual terminals. */
export const terminalRegions: readonly {
  readonly region: string;
  readonly item: RegionItem;
}[] = [
  {
    region: 'layout.header',
    item: { id: 'terminal-new', tag: 'terminal-new-button', order: 10 },
  },
  {
    region: 'layout.main.bottom',
    item: { id: MANUAL_ITEM_ID, tag: 'terminal-manual' },
  },
];

/**
 * Adds the header button, the bottom section's manual terminals and the
 * sidebar's terminal rows (WP-10N). The rows' count follows each Thread's
 * Project on first use, as the renderer followed every loaded Project.
 */
export const registerTerminalSurfaces = (
  regions: Pick<Regions, 'add'>,
  sidebar: LayoutSidebar,
  store: TerminalStore,
  workspace: () => Pick<LayoutWorkspace, 'thread'> | undefined,
): Disposable => {
  const added = terminalRegions.map(({ region, item }) =>
    regions.add(region, item),
  );
  added.push(
    sidebar.addThreadRows({
      id: 'terminals',
      tag: 'terminal-rows',
      count: (threadId) => {
        const projectId = workspace()?.thread(threadId)?.projectId;
        if (projectId !== undefined) store.follow(projectId);
        return store.threadTerminals(threadId).length;
      },
      subscribe: (listener) => store.subscribe(listener),
    }),
  );
  return {
    dispose: () => {
      for (const item of added.reverse()) item.dispose();
    },
  };
};

/**
 * Shows the bottom section while the selected Thread's manual terminal is
 * one the store lists, as the workspace view rendered it.
 */
const followBottom = (
  store: TerminalStore,
  workspace: LayoutWorkspace,
): (() => void) => {
  let shown = false;
  const sync = () => {
    const thread = workspace.selectedThread();
    const manualId =
      thread === undefined ? undefined : store.manual(thread.id).manualId;
    const visible =
      manualId !== undefined &&
      store.terminals().some((terminal) => terminal.id === manualId);
    if (visible === shown) return;
    shown = visible;
    workspace.setBottomVisible(MANUAL_ITEM_ID, visible);
  };
  const fromStore = store.subscribe(sync);
  const fromWorkspace = workspace.subscribe(sync);
  sync();
  return () => {
    fromWorkspace.dispose();
    fromStore.dispose();
    if (shown) workspace.setBottomVisible(MANUAL_ITEM_ID, false);
  };
};

const threadRoute = (projectId: string, threadId: string): string =>
  `/projects/${encodeURIComponent(projectId)}/threads/${encodeURIComponent(threadId)}`;

/** A row's click: select the owning Thread, then show or open the terminal. */
const opener =
  (services: Services, store: TerminalStore) => (terminal: Terminal) => {
    let workspace: LayoutWorkspace | undefined;
    try {
      workspace = services.use(LayoutWorkspaceV1);
    } catch {
      workspace = undefined;
    }
    const thread = workspace?.thread(terminal.threadId);
    if (thread !== undefined)
      services
        .use(NavigationV1)
        .navigate(threadRoute(thread.projectId, thread.id));
    if (terminal.origin === 'user') {
      store.showManual(terminal.threadId, terminal.id);
      return;
    }
    void services
      .use(LayoutTabsV1)
      .open({
        id: `terminal:${terminal.id}`,
        title: terminal.command || 'Terminal',
        tag: TERMINAL_VIEW_TAG,
        props: { terminalId: terminal.id, showHeader: true },
        icon: 'terminal',
      })
      // Only a window with nothing selected refuses, which a row's click
      // has just selected.
      .catch(() => undefined);
  };

export function activate({ services }: ClientContext): Cleanup {
  const terminals = () => services.use(TerminalServiceV1);
  const api = createTerminalApi(terminals);
  const watches = createTerminalWatches({
    terminals: {
      watchProject: (id, listener) => terminals().watchProject(id, listener),
    },
    snapshot: (id) => api.snapshot(id),
    connection: services.use(DoricConnectionV1),
  });
  const store = createTerminalStore({
    api,
    watchProject: watches.watchProject,
    toastError: (message) => toast.error(message),
    closeTab: (input) => {
      void services
        .use(LayoutTabsV1)
        .close(input)
        .catch(() => undefined);
    },
    refreshFiles: (projectId) => {
      try {
        services.use(FilesRefreshV1).request(projectId);
      } catch {
        // Without the files bundle nothing reads the Project's sandbox.
      }
    },
  });
  const client: TerminalClient = {
    api,
    watches,
    store,
    open: opener(services, store),
  };

  const ui = services.use(UiV1);
  const elements = defineTerminalElements(client);
  const defined = [
    ui.define('terminal-new-button', elements.newButton),
    ui.define('terminal-rows', elements.rows),
    ui.define('terminal-manual', elements.manual),
    ui.define(TERMINAL_VIEW_TAG, elements.view),
  ];

  const bottom = services.whenAvailable(LayoutWorkspaceV1, (workspace) =>
    followBottom(store, workspace),
  );
  const surfaces = services.whenAvailable(LayoutSidebarV1, (sidebar) => {
    const registered = registerTerminalSurfaces(
      services.use(RegionsV1),
      sidebar,
      store,
      () => {
        try {
          return services.use(LayoutWorkspaceV1);
        } catch {
          return undefined;
        }
      },
    );
    return () => registered.dispose();
  });

  return () => {
    surfaces.dispose();
    bottom.dispose();
    for (const element of defined.reverse()) element.dispose();
    store.dispose();
    watches.close();
  };
}
