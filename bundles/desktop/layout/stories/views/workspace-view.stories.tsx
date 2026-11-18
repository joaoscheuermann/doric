import { WorkspaceView } from '../../src/client/views/workspace-view.js';
import { type LayoutFixture, LayoutHost } from '../support/layout-host.js';
import {
  checkoutTabs,
  childThreadId,
  dashboardStandIns,
  navigationStandIns,
  owner,
  projectId,
  projectRoute,
  threadRoute,
} from '../support/tabs.js';
import { windowDecorator } from '../support/window-frame.js';

const workspace: LayoutFixture = {
  path: threadRoute,
  owner,
  regions: navigationStandIns,
  tabs: checkoutTabs,
  // The files bundle selects its view through `layout.panel/v3` as it activates.
  panel: { active: 'files' },
};

const agentThreadId = '5b3c7d9e-1f2a-4b3c-8d4e-5f6a7b8c9d0e';

const fixtures = {
  thread: workspace,
  childThread: {
    ...workspace,
    tabs: {
      [owner]: [
        {
          id: `thread:${childThreadId}`,
          title: 'Build the payment form',
          tag: 'chat-thread-panel',
          iconTag: 'chat-thread-tab-icon',
          openBottom: true,
          props: { projectId, threadId: childThreadId },
        },
      ],
    },
  },
  /** A sub-thread and an agent Thread open side by side, the agent's selected. */
  threadKinds: {
    ...workspace,
    tabs: {
      [owner]: [
        {
          id: `thread:${childThreadId}`,
          title: 'Build the payment form',
          tag: 'chat-thread-panel',
          iconTag: 'chat-thread-tab-icon',
          openBottom: true,
          props: { projectId, threadId: childThreadId },
        },
        {
          id: `thread:${agentThreadId}`,
          title: 'Validate inputs',
          tag: 'chat-thread-panel',
          iconTag: 'chat-thread-tab-icon',
          openBottom: true,
          props: { projectId, threadId: agentThreadId },
        },
      ],
    },
  },
  terminals: { ...workspace, bottom: true },
  changes: { ...workspace, panel: { active: 'changes' } },
  disconnected: { ...workspace, connection: 'disconnected' },
  project: {
    ...workspace,
    path: projectRoute,
    owner: `project:${projectId}`,
    tabs: {},
  },
  dashboard: { path: '/projects', regions: dashboardStandIns },
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

/** The Dashboard: every Project, with its activity. */
export const Dashboard = {
  render: () => (
    <LayoutHost fixture={fixtures.dashboard}>
      <WorkspaceView />
    </LayoutHost>
  ),
};
