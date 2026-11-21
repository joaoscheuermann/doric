// The terminal bundle's client part (stage 10, §3.10): the window's terminal
// store over `terminal/v1`, and the header's "New terminal" button,
// sidebar terminal rows, shared workspace terminal view and the terminal tab's
// icon (`terminal-tab-icon`). All are bound to the
// activation services, never to an element's (D9-17).
//
// Bundle isolation 5(b): the chat's drawings of a `terminal` call
// (`terminal-tool-call`) and of a background terminal's answer, the source
// `terminal` (`terminal-result`), registered while `chat.views/v1` is served.
//
// The header region item and the sidebar rows are registered by
// `registerTerminalSurfaces` while `workspace` serves `workspace.sidebar/v1`,
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
import type { SHELL_HEADER_ACTIONS } from 'layout/contracts';

import { TerminalServiceV1 } from '../contracts/index.js';
import { createTerminalApi } from './api.js';
import {
  defineTerminalCallElement,
  TERMINAL_CALL_TAG,
  TERMINAL_TOOL,
} from './chat/terminal-call.js';
import {
  defineTerminalResultElement,
  TERMINAL_RESULT_TAG,
  TERMINAL_SOURCE,
} from './chat/terminal-result.js';
import { isAgentBusy, type Terminal } from './domain/terminals.js';
import { defineTerminalElements, type TerminalClient } from './elements.js';
import { createTerminalWatches } from './output-watch.js';
import {
  ChatViewsV1,
  FilesRefreshV1,
  LayoutTabsV2,
  type RecordsSource,
  RuntimeRecordsV1,
  type WorkspaceSidebar,
  WorkspaceSidebarV1,
} from './peers.js';
import { createTerminalStore, type TerminalStore } from './store.js';
import {
  TERMINAL_TAB_ICON_TAG,
  TERMINAL_VIEW_TAG,
  terminalTab,
} from './tab.js';

/** The region item of the header's new-terminal button. */
export const terminalRegions: readonly {
  readonly region: string;
  readonly item: RegionItem;
}[] = [
  {
    region: 'shell.header.actions' satisfies typeof SHELL_HEADER_ACTIONS,
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
  sidebar: WorkspaceSidebar,
  store: TerminalStore,
  records: () => Pick<RecordsSource, 'thread'> | undefined,
): Disposable => {
  const added = terminalRegions.map(({ region, item }) =>
    regions.add(region, item),
  );
  // `busy` runs for every Thread on every render of the tree, so it answers
  // from memory: each Thread's Project is resolved once (again only while the
  // records do not hold the Thread yet), and the busy Thread ids are
  // rebuilt only after the store changed.
  const projects = new Map<string, string>();
  const projectOf = (threadId: string): string | undefined => {
    const known = projects.get(threadId);
    if (known !== undefined) return known;
    const projectId = records()?.thread(threadId)?.projectId;
    if (projectId !== undefined) projects.set(threadId, projectId);
    return projectId;
  };
  let busyThreads: ReadonlySet<string> | undefined;
  added.push(
    store.subscribe(() => {
      busyThreads = undefined;
    }),
  );
  added.push(
    sidebar.addThreadRows({
      id: 'terminals',
      tag: 'terminal-rows',
      count: (threadId) => {
        const projectId = records()?.thread(threadId)?.projectId;
        if (projectId !== undefined) store.follow(projectId);
        return store.threadTerminals(threadId).length;
      },
      subscribe: (listener) => store.subscribe(listener),
      busy: (threadId) => {
        const projectId = projectOf(threadId);
        if (projectId !== undefined) store.follow(projectId);
        busyThreads ??= new Set(
          store
            .terminals()
            .filter(isAgentBusy)
            .map((terminal) => terminal.threadId),
        );
        return busyThreads.has(threadId);
      },
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

/**
 * A row's click: select the owning Thread, then show or open the terminal;
 * its tab's Kill terminal (A7) runs `kill`.
 */
const opener =
  (services: Services, kill: (terminalId: string) => void) =>
  async (terminal: Terminal) => {
    let records: RecordsSource | undefined;
    try {
      records = services.use(RuntimeRecordsV1);
    } catch {
      records = undefined;
    }
    const thread = records?.thread(terminal.threadId);
    if (thread !== undefined)
      services
        .use(NavigationV1)
        .navigate(threadRoute(thread.projectId, thread.id));
    await services.use(LayoutTabsV2).open(terminalTab(terminal, kill));
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
  // A7: the tab's Kill terminal stops it as the row's does (A15).
  const open = opener(services, (terminalId) => store.stop(terminalId));
  const store = createTerminalStore({
    api,
    openTerminal: open,
    watchProject: watches.watchProject,
    toastError: (message) => toast.error(message),
    closeTab: (input) => {
      void services
        .use(LayoutTabsV2)
        .close(input)
        .catch(() => undefined);
    },
    retitleTab: (input) => {
      try {
        void services
          .use(LayoutTabsV2)
          .retitle(input)
          .catch(() => undefined);
      } catch {
        // Without the layout there is no tab to retitle.
      }
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
      void open(terminal).catch((error: unknown) =>
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
    ui.define(TERMINAL_TAB_ICON_TAG, elements.tabIcon),
    ui.define(TERMINAL_CALL_TAG, defineTerminalCallElement(client)),
    ui.define(TERMINAL_RESULT_TAG, defineTerminalResultElement(client)),
  ];

  // The chat's drawings of the `terminal` tool and of the source `terminal`
  // (chat.views/v1 1.2.0), each in a callback of its own: a refused
  // registration leaves the other.
  const chatViews = [
    services.whenAvailable(ChatViewsV1, (views) => {
      const registered = views.registerToolRenderer({
        toolName: TERMINAL_TOOL,
        elementTag: TERMINAL_CALL_TAG,
      });
      return () => registered.dispose();
    }),
    services.whenAvailable(ChatViewsV1, (views) => {
      const registered = views.registerInputRenderer({
        source: TERMINAL_SOURCE,
        elementTag: TERMINAL_RESULT_TAG,
      });
      return () => registered.dispose();
    }),
  ];

  const surfaces = services.whenAvailable(WorkspaceSidebarV1, (sidebar) => {
    const registered = registerTerminalSurfaces(
      services.use(RegionsV1),
      sidebar,
      store,
      () => {
        try {
          return services.use(RuntimeRecordsV1);
        } catch {
          return undefined;
        }
      },
    );
    return () => registered.dispose();
  });

  return () => {
    for (const registration of chatViews.reverse()) registration.dispose();
    surfaces.dispose();
    for (const element of defined.reverse()) element.dispose();
    store.dispose();
    watches.close();
  };
}
