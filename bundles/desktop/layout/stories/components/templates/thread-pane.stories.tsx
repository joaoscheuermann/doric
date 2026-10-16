import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from 'desktop/ui/empty';

import { ConversationTerminals } from '../../../src/client/components/templates/conversation-terminals.js';
import { ThreadPane } from '../../../src/client/components/templates/thread-pane.js';
import { checkout, planThread, projectRoute } from '../../support/data.js';
import { LayoutHost } from '../../support/layout-host.js';
import { Placeholder } from '../../support/placeholder.js';
import { WorkspaceShell } from '../../support/shell.js';
import { windowDecorator } from '../../support/window-frame.js';
import { sidebarModelOf } from '../../support/workspace.js';

const noThread = sidebarModelOf({ selectedThreadId: undefined });

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
          <ThreadPane>
            <Placeholder
              tag="chat-thread"
              label={`Conversation: ${planThread.name}`}
            />
          </ThreadPane>
        </ConversationTerminals>
      </WorkspaceShell>
    </LayoutHost>
  ),
};

/** No Thread selected: what the workspace view puts in the pane. */
export const NoThread = {
  render: () => (
    <LayoutHost>
      <WorkspaceShell path={projectRoute(checkout)} model={noThread}>
        <ConversationTerminals>
          <ThreadPane>
            <Empty>
              <EmptyHeader>
                <EmptyTitle>{checkout.name}</EmptyTitle>
                <EmptyDescription>
                  Start a thread or select one from the sidebar.
                </EmptyDescription>
              </EmptyHeader>
              <button type="button" className="dashboard-new">
                New thread
              </button>
            </Empty>
          </ThreadPane>
        </ConversationTerminals>
      </WorkspaceShell>
    </LayoutHost>
  ),
};
