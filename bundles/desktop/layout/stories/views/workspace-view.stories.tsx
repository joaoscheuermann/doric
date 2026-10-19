import { WorkspaceView } from '../../src/client/views/workspace-view.js';
import {
  billing,
  checkout,
  checkoutTabs,
  docs,
  empty,
  formThread,
  planThread,
  projectRoute,
  projects,
  threadRoute,
  threads,
  validationThread,
} from '../support/data.js';
import { type LayoutFixture, LayoutHost } from '../support/layout-host.js';
import { windowDecorator } from '../support/window-frame.js';

const workspace: LayoutFixture = {
  projects: [...projects, empty],
  threads,
  path: threadRoute(planThread),
  projectTabs: [checkout, docs, billing],
  tabs: checkoutTabs,
  terminalRows: { [formThread.id]: 1 },
};

const fixtures = {
  thread: workspace,
  childThread: {
    ...workspace,
    path: threadRoute(validationThread),
    tabs: {
      [planThread.id]: [
        {
          id: `thread:${validationThread.id}`,
          title: validationThread.name,
          tag: 'chat-thread-panel',
          icon: 'thread',
          props: { projectId: checkout.id, threadId: validationThread.id },
        },
      ],
    },
  },
  /** A sub-thread and an agent Thread open side by side, the agent's selected. */
  threadKinds: {
    ...workspace,
    path: threadRoute(validationThread),
    // An open terminal and a running one under the sub-thread, and the same
    // under the agent Thread: the rows the sidebar always drew.
    terminalRows: { [formThread.id]: 2, [validationThread.id]: 2 },
    tabs: {
      [planThread.id]: [
        {
          id: `thread:${formThread.id}`,
          title: formThread.name,
          tag: 'chat-thread-panel',
          icon: 'thread',
          props: { projectId: checkout.id, threadId: formThread.id },
        },
        {
          id: `thread:${validationThread.id}`,
          title: validationThread.name,
          tag: 'chat-thread-panel',
          icon: 'thread',
          props: { projectId: checkout.id, threadId: validationThread.id },
        },
      ],
    },
  },
  terminals: { ...workspace, bottom: true },
  changes: { ...workspace, panel: { active: 'changes' } },
  focused: { ...workspace, tabs: {}, panel: { open: false } },
  disconnected: { ...workspace, connection: 'disconnected' },
  project: { ...workspace, path: projectRoute(empty), tabs: {} },
  dashboard: { ...workspace, path: '/projects' },
  firstRun: { projects: [], threads: [], path: '/projects' },
  loading: { ...workspace, path: '/projects', pending: ['projects'] },
  unavailable: {
    ...workspace,
    path: '/projects',
    failing: ['projects', 'activity'],
  },
} satisfies Record<string, LayoutFixture>;

export default {
  title: 'Layout/Views/Workspace view',
  component: WorkspaceView,
  decorators: [windowDecorator],
};

/**
 * The workspace with the Checkout plan Thread open: Project tabs, the Threads
 * tree with child Threads, a running agent and terminal rows, the open file,
 * diff and child Thread tabs, the Files panel and both footers.
 */
export const Thread = {
  render: () => (
    <LayoutHost fixture={fixtures.thread}>
      <WorkspaceView />
    </LayoutHost>
  ),
};

/** A link to a child Thread: its root is selected and the child is a tab. */
export const ChildThread = {
  render: () => (
    <LayoutHost fixture={fixtures.childThread}>
      <WorkspaceView />
    </LayoutHost>
  ),
};

/** A sub-thread and an agent Thread open as tabs: each trigger wears its kind. */
export const ThreadKindTabs = {
  render: () => (
    <LayoutHost fixture={fixtures.threadKinds}>
      <WorkspaceView />
    </LayoutHost>
  ),
};

/** The terminal bundle asked for the split under the conversation. */
export const WithTerminals = {
  render: () => (
    <LayoutHost fixture={fixtures.terminals}>
      <WorkspaceView />
    </LayoutHost>
  ),
};

/** The Project panel on the Changes view. */
export const ChangesPanel = {
  render: () => (
    <LayoutHost fixture={fixtures.changes}>
      <WorkspaceView />
    </LayoutHost>
  ),
};

/** No tab open and the Project panel closed. */
export const Focused = {
  render: () => (
    <LayoutHost fixture={fixtures.focused}>
      <WorkspaceView />
    </LayoutHost>
  ),
};

export const Disconnected = {
  render: () => (
    <LayoutHost fixture={fixtures.disconnected}>
      <WorkspaceView />
    </LayoutHost>
  ),
};

/** A Project with no Thread yet: the empty pane offers to start one. */
export const ProjectWithoutThreads = {
  render: () => (
    <LayoutHost fixture={fixtures.project}>
      <WorkspaceView />
    </LayoutHost>
  ),
};

/** The Dashboard tab: every Project, with its activity. */
export const Dashboard = {
  render: () => (
    <LayoutHost fixture={fixtures.dashboard}>
      <WorkspaceView />
    </LayoutHost>
  ),
};

/** The first launch: no Project yet. */
export const FirstRun = {
  render: () => (
    <LayoutHost fixture={fixtures.firstRun}>
      <WorkspaceView />
    </LayoutHost>
  ),
};

/** The Projects are still arriving from the host. */
export const LoadingProjects = {
  render: () => (
    <LayoutHost fixture={fixtures.loading}>
      <WorkspaceView />
    </LayoutHost>
  ),
};

/** The host does not answer: the dashboard's error and retry. */
export const HostUnavailable = {
  render: () => (
    <LayoutHost fixture={fixtures.unavailable}>
      <WorkspaceView />
    </LayoutHost>
  ),
};
