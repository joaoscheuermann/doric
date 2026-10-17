// `<chat-view>`'s content over the story host: the Thread's record comes from
// the sidebar tree, its log is replayed by `runtime.threads/v1.watchThread`
// into the Thread chat store, its queue is in the window's query client and
// its composer stack in `chat.composer/v1`, so each story is the conversation
// a window draws for that Thread. Sending works: the host accepts the prompt
// and answers it once.

import type { ComponentType } from 'react';

import { ChatView } from '../../src/client/views/chat-view.js';
import { ChatHost, storyServices } from '../support/chat-host.js';
import { projectId, threadIds } from '../support/fixtures.js';

const services = storyServices();

export default {
  title: 'Chat/Views/Chat view',
  component: ChatView,
  decorators: [
    (Story: ComponentType) => (
      <ChatHost>
        <div className="flex h-[720px] min-h-0 overflow-hidden rounded-lg border">
          <Story />
        </div>
      </ChatHost>
    ),
  ],
};

/** A settled exchange: reasoning, tool calls, an edit, a test run, answers. */
export const Conversation = {
  render: () => (
    <ChatView
      projectId={projectId}
      threadId={threadIds.conversation}
      services={services}
    />
  ),
};

/** The agent is mid-run: a running terminal call and the Stop footer. */
export const Running = {
  render: () => (
    <ChatView
      projectId={projectId}
      threadId={threadIds.running}
      services={services}
      withFooter
    />
  ),
};

/** Paused queue with two receipts waiting below the last answer. */
export const QueuedPrompts = {
  render: () => (
    <ChatView
      projectId={projectId}
      threadId={threadIds.queued}
      services={services}
      withFooter
    />
  ),
};

/** A host stop left a prompt paused; the next one failed. */
export const PausedAndFailed = {
  render: () => (
    <ChatView
      projectId={projectId}
      threadId={threadIds.paused}
      services={services}
    />
  ),
};

/** Comments sent with a prompt, the agent's replies, and new drafts stacked. */
export const Comments = {
  render: () => (
    <ChatView
      projectId={projectId}
      threadId={threadIds.comments}
      services={services}
    />
  ),
};

/** A subthread's result handed back to the Thread that delegated it. */
export const SubthreadResult = {
  render: () => (
    <ChatView
      projectId={projectId}
      threadId={threadIds.delegated}
      services={services}
    />
  ),
};

export const EmptyThread = {
  render: () => (
    <ChatView
      projectId={projectId}
      threadId={threadIds.empty}
      services={services}
      withFooter
    />
  ),
};

/** The thread panel's variant: the conversation with its own footer. */
export const WithFooter = {
  render: () => (
    <ChatView
      projectId={projectId}
      threadId={threadIds.conversation}
      services={services}
      withFooter
    />
  ),
};

/** A route that names no Thread draws nothing. */
export const NoThread = {
  render: () => <ChatView services={services} />,
};
