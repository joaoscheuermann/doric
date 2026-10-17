import { ConversationTerminals } from '../../../src/client/components/templates/conversation-terminals.js';
import { ThreadPane } from '../../../src/client/components/templates/thread-pane.js';
import { planThread } from '../../support/data.js';
import { LayoutHost } from '../../support/layout-host.js';
import { Placeholder } from '../../support/placeholder.js';
import { WorkspaceShell } from '../../support/shell.js';
import { windowDecorator } from '../../support/window-frame.js';

const conversation = (
  <ThreadPane>
    <Placeholder tag="chat-thread" label={`Conversation: ${planThread.name}`} />
  </ThreadPane>
);

export default {
  title: 'Layout/Templates/Conversation terminals',
  component: ConversationTerminals,
  decorators: [windowDecorator],
};

/** The conversation over the terminal bundle's split. */
export const WithTerminals = {
  render: () => (
    <LayoutHost>
      <WorkspaceShell>
        <ConversationTerminals bottom={<Placeholder tag="terminal-panel" />}>
          {conversation}
        </ConversationTerminals>
      </WorkspaceShell>
    </LayoutHost>
  ),
};

/** No item asked for the split: the conversation fills the column. */
export const ConversationOnly = {
  render: () => (
    <LayoutHost>
      <WorkspaceShell>
        <ConversationTerminals>{conversation}</ConversationTerminals>
      </WorkspaceShell>
    </LayoutHost>
  ),
};
