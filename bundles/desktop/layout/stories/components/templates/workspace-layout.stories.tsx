import { ConversationTerminals } from '../../../src/client/components/templates/conversation-terminals.js';
import { ThreadPane } from '../../../src/client/components/templates/thread-pane.js';
import { WorkspaceLayout } from '../../../src/client/components/templates/workspace-layout.js';
import { checkoutTabs, planThread } from '../../support/data.js';
import { type LayoutFixture, LayoutHost } from '../../support/layout-host.js';
import { Placeholder } from '../../support/placeholder.js';
import { WorkspaceShell } from '../../support/shell.js';
import { windowDecorator } from '../../support/window-frame.js';

function Conversation() {
  return (
    <ConversationTerminals>
      <ThreadPane>
        <Placeholder
          tag="chat-thread"
          label={`Conversation: ${planThread.name}`}
        />
      </ThreadPane>
    </ConversationTerminals>
  );
}

const withTabs: LayoutFixture = { tabs: checkoutTabs };
const noTabs: LayoutFixture = {};

export default {
  title: 'Layout/Templates/Workspace layout',
  component: WorkspaceLayout,
  decorators: [windowDecorator],
};

/**
 * The whole frame: Project tabs, the Threads sidebar, the conversation, the
 * open file, diff and child Thread tabs, and the Files panel.
 */
export const Workspace = {
  render: () => (
    <LayoutHost fixture={withTabs}>
      <WorkspaceShell>
        <Conversation />
      </WorkspaceShell>
    </LayoutHost>
  ),
};

/** No tab open: the conversation reaches the Project panel. */
export const NoOpenTabs = {
  render: () => (
    <LayoutHost fixture={noTabs}>
      <WorkspaceShell>
        <Conversation />
      </WorkspaceShell>
    </LayoutHost>
  ),
};

/** The Project panel closed: its controls stay in the tab bar. */
export const PanelClosed = {
  render: () => (
    <LayoutHost fixture={withTabs}>
      <WorkspaceShell panelOpen={false}>
        <Conversation />
      </WorkspaceShell>
    </LayoutHost>
  ),
};

/** Only the sidebar and the conversation: no tabs, panel closed. */
export const Focused = {
  render: () => (
    <LayoutHost fixture={noTabs}>
      <WorkspaceShell panelOpen={false}>
        <Conversation />
      </WorkspaceShell>
    </LayoutHost>
  ),
};
