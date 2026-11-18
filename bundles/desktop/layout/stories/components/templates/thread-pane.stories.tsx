import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from 'desktop/ui/empty';

import { ConversationTerminals } from '../../../src/client/components/templates/conversation-terminals.js';
import { ThreadPane } from '../../../src/client/components/templates/thread-pane.js';
import { LayoutHost } from '../../support/layout-host.js';
import { Placeholder } from '../../support/placeholder.js';
import { ContentFrame, WorkspaceShell } from '../../support/shell.js';
import { conversationLabel } from '../../support/tabs.js';
import { windowDecorator } from '../../support/window-frame.js';

export default {
  title: 'Layout/Templates/Thread pane',
  component: ThreadPane,
  decorators: [windowDecorator],
};

/** The selected Thread's conversation, drawn by the chat bundle. */
export const Conversation = {
  render: () => (
    <LayoutHost>
      <WorkspaceShell>
        <ConversationTerminals>
          <ContentFrame>
            <ThreadPane>
              <Placeholder tag="chat-thread" label={conversationLabel} />
            </ThreadPane>
          </ContentFrame>
        </ConversationTerminals>
      </WorkspaceShell>
    </LayoutHost>
  ),
};

/** No Thread selected: what the workspace view puts in the pane. */
export const NoThread = {
  render: () => (
    <LayoutHost>
      <WorkspaceShell owner="project:6f1c2a3e-4b5d-4e6f-8a7b-1c2d3e4f5a6b">
        <ConversationTerminals>
          <ContentFrame>
            <ThreadPane>
              <Empty>
                <EmptyHeader>
                  <EmptyTitle>Checkout redesign</EmptyTitle>
                  <EmptyDescription>
                    Start a thread or select one from the sidebar.
                  </EmptyDescription>
                </EmptyHeader>
                <button type="button" className="dashboard-new">
                  New thread
                </button>
              </Empty>
            </ThreadPane>
          </ContentFrame>
        </ConversationTerminals>
      </WorkspaceShell>
    </LayoutHost>
  ),
};
