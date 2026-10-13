// The terminal bundle's client part (stage 10, §3.10): the window's terminal
// store over `terminal/v1`, and the header's "New terminal" button,
// sidebar terminal rows and shared workspace terminal view. All are bound to the
// activation services, never to an element's (D9-17).
//
// The header region item and the sidebar rows are registered by
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

/** The region item of the header's new-terminal button. */
export const terminalRegions: readonly {
  readonly region: string;
  readonly item: RegionItem;
}[] = [
  {
    region: 'layout.header',
    item: { id: 'terminal-new', tag: 'terminal-new-button', order: 10 },
  },
];

/**
 * Adds the header button and the
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

const threadRoute = (projectId: string, threadId: string): string =>
  `/projects/${encodeURIComponent(projectId)}/threads/${encodeURIComponent(threadId)}`;

/** A row's click: select the owning Thread, then show or open the terminal. */
const opener = (services: Services) => async (terminal: Terminal) => {
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
  await services.use(LayoutTabsV1).open({
    id: `terminal:${terminal.id}`,
    title: terminal.command || 'Terminal',
    tag: TERMINAL_VIEW_TAG,
    props: { terminalId: terminal.id, showHeader: terminal.origin !== 'user' },
    icon: 'terminal',
  });
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
    openTerminal: opener(services),
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
    open: (terminal) => {
      void opener(services)(terminal).catch((error: unknown) =>
        toast.error(
          error instanceof Error ? error.message : 'Could not open terminal.',
        ),
      );
    },
  };

  const ui = services.use(UiV1);
  const elements = defineTerminalElements(client);
  const defined = [
    ui.define('terminal-new-button', elements.newButton),
    ui.define('terminal-rows', elements.rows),
    ui.define(TERMINAL_VIEW_TAG, elements.view),
  ];

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
    for (const element of defined.reverse()) element.dispose();
    store.dispose();
    watches.close();
  };
}
