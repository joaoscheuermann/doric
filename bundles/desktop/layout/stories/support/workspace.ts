// The models and actions the layout's organisms take as props, built from
// the story data. Actions only report themselves in the console: a story that
// needs one to change what is drawn keeps its own state.

import type {
  SidebarActions,
  SidebarModel,
} from '../../src/client/components/organisms/project-sidebar.js';
import type { ProjectTabs } from '../../src/client/domain/project-tabs.js';
import type { Project, Thread } from '../../src/client/domain/workspace.js';
import type {
  Workspace,
  WorkspaceActions,
} from '../../src/client/hooks/use-workspace.js';
import { checkout, checkoutThreads, planThread, projects } from './data.js';

const report =
  (name: string) =>
  (...args: readonly unknown[]): void => {
    console.info(`Story action: ${name}`, ...args);
  };

const reportAsync =
  (name: string) =>
  (...args: readonly unknown[]): Promise<void> => {
    console.info(`Story action: ${name}`, ...args);
    return Promise.resolve();
  };

export const workspaceActions: WorkspaceActions = {
  beginProject: report('beginProject'),
  beginThread: report('beginThread'),
  cancelDraft: report('cancelDraft'),
  cancelRename: report('cancelRename'),
  confirmDelete: reportAsync('confirmDelete'),
  copyThreadId: report('copyThreadId'),
  createProject: reportAsync('createProject'),
  createThread: reportAsync('createThread'),
  dismissDelete: report('dismissDelete'),
  rename: reportAsync('rename'),
  requestDelete: report('requestDelete'),
  selectProject: report('selectProject'),
  selectThread: report('selectThread'),
  setProjectColor: report('setProjectColor'),
  startRename: report('startRename'),
};

export const sidebarActions: SidebarActions = {
  beginProject: workspaceActions.beginProject,
  beginThread: workspaceActions.beginThread,
  cancelDraft: workspaceActions.cancelDraft,
  cancelRename: workspaceActions.cancelRename,
  copyThreadId: workspaceActions.copyThreadId,
  createProject: workspaceActions.createProject,
  createThread: workspaceActions.createThread,
  deleteEntity: workspaceActions.requestDelete,
  rename: workspaceActions.rename,
  selectProject: workspaceActions.selectProject,
  selectThread: workspaceActions.selectThread,
  setProjectColor: workspaceActions.setProjectColor,
  startRename: workspaceActions.startRename,
};

/** The workspace the dashboard reads: every Project loaded, nothing pending. */
export const workspaceOf = (overrides: Partial<Workspace> = {}): Workspace => ({
  actions: workspaceActions,
  deletingPending: false,
  loadingProjectThreads: new Set(),
  loadingProjects: false,
  projects,
  threadsByProject: { [checkout.id]: checkoutThreads },
  ...overrides,
});

/** The sidebar of the Checkout Project with its plan Thread selected. */
export const sidebarModelOf = (
  overrides: Partial<SidebarModel> = {},
): SidebarModel => ({
  loadingProjectThreads: new Set(),
  loadingProjects: false,
  projects,
  selectedProjectId: checkout.id,
  selectedThreadId: planThread.id,
  threadsByProject: { [checkout.id]: checkoutThreads },
  ...overrides,
});

/** The Project tab strip with `open` left open, in order. */
export const projectTabsOf = (open: readonly Project[]): ProjectTabs => ({
  homePath: '/',
  order: open.map((project) => project.id),
  paths: Object.fromEntries(
    open.map((project) => [project.id, `/projects/${project.id}`]),
  ),
});

/** The breadcrumb's chain for `thread` within `list`. */
export const pathTo = (
  list: readonly Thread[],
  thread: Thread,
): readonly Thread[] => {
  const chain: Thread[] = [];
  let current: Thread | undefined = thread;
  while (current !== undefined) {
    chain.unshift(current);
    const parent: string | undefined = current.parentThreadId;
    current =
      parent === undefined
        ? undefined
        : list.find((candidate) => candidate.id === parent);
  }
  return chain;
};
