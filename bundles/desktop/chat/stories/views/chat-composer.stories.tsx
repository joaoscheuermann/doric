// `<chat-composer>`'s content, the `layout.footer` item: the controls for the
// Thread the sidebar selects. The story host's tree selects the story's
// Thread; its queue and draft come from the host.

import type { ReactNode } from 'react';

import {
  ChatComposer,
  ThreadComposer,
} from '../../src/client/views/chat-composer.js';
import { ChatHost } from '../support/chat-host.js';
import { threadIds, threads } from '../support/fixtures.js';

/** The content footer the item sits at the end of. */
function Footer({ children }: { readonly children: ReactNode }) {
  return (
    <footer className="flex chrome-bar items-center justify-end gap-2 border-t bg-sidebar px-2 text-xs text-muted-foreground">
      <span className="mr-auto">storefront · main</span>
      {children}
    </footer>
  );
}

export default {
  title: 'Chat/Views/Chat composer',
  component: ChatComposer,
};

export const SelectedThread = {
  render: () => (
    <ChatHost selectedThread={threadIds.conversation}>
      <Footer>
        <ChatComposer />
      </Footer>
    </ChatHost>
  ),
};

export const SelectedRunning = {
  render: () => (
    <ChatHost selectedThread={threadIds.running}>
      <Footer>
        <ChatComposer />
      </Footer>
    </ChatHost>
  ),
};

export const SelectedWithQueue = {
  render: () => (
    <ChatHost selectedThread={threadIds.queued}>
      <Footer>
        <ChatComposer />
      </Footer>
    </ChatHost>
  ),
};

/** A stack of drafted comments is something to send without words. */
export const SelectedWithCommentStack = {
  render: () => (
    <ChatHost selectedThread={threadIds.comments}>
      <Footer>
        <ChatComposer />
      </Footer>
    </ChatHost>
  ),
};

export const NoSelection = {
  render: () => (
    <ChatHost>
      <Footer>
        <ChatComposer />
      </Footer>
    </ChatHost>
  ),
};

/** The controls bound to one conversation's record, whatever is selected. */
export const BoundToThread = {
  render: () => (
    <ChatHost>
      <Footer>
        <ThreadComposer thread={threads.running} />
      </Footer>
    </ChatHost>
  ),
};

/**
 * An agent Thread, running: where the composer would be, the three levers the
 * reader has on a run it did not start, with only Pause available.
 */
export const AgentRunning = {
  render: () => (
    <ChatHost selectedThread={threadIds.agentRunning}>
      <Footer>
        <ThreadComposer thread={threads.agentRunning} />
      </Footer>
    </ChatHost>
  ),
};

/** An agent Thread the reader paused: only Continue applies. */
export const AgentPaused = {
  render: () => (
    <ChatHost selectedThread={threadIds.agentPaused}>
      <Footer>
        <ThreadComposer thread={threads.agentPaused} />
      </Footer>
    </ChatHost>
  ),
};

/** An agent Thread whose prompt failed: only Retry applies. */
export const AgentFailed = {
  render: () => (
    <ChatHost selectedThread={threadIds.agentFailed}>
      <Footer>
        <ThreadComposer thread={threads.agentFailed} />
      </Footer>
    </ChatHost>
  ),
};
