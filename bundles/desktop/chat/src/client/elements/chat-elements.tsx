// The chat bundle's elements (§7.3-§7.7). `<chat-view>` (the Thread route)
// and `<chat-composer>` (a `shell.conversation.footer` item) each own a React root over
// the one chat query client, with a tooltip provider per root; neither
// mounts a toaster, since the window's single toaster belongs to the layout
// and `toast` reaches it through `desktop/ui/sonner`. `<chat-block>` draws a
// block no renderer claims. `<chat-readonly-markdown text>` (R-9.9) is the
// conversation's read-only Markdown for another bundle's block element.
// `<chat-thread-tab-icon projectId threadId>` (bundle isolation 4a) is the
// mark the layout draws on a Thread's tab.

import { QueryClientProvider } from '@tanstack/react-query';
import { defineReactElement } from 'desktop/ui/react-element';
import { TooltipProvider } from 'desktop/ui/tooltip';
import { type ReactNode, StrictMode, useSyncExternalStore } from 'react';
import { RuntimeRecordsV1 } from 'runtime/contracts';

import type { RenderBlock } from '../../contracts/index.js';
import { GenericBlock } from '../components/molecules/generic-block.js';
import { ThreadTabIcon } from '../components/molecules/thread-tab-icon.js';
import { ReadonlyMarkdownView } from '../components/organisms/conversation/readonly-markdown.js';
import { conversationTheme } from '../components/organisms/conversation/theme.js';
import { chatQueryClient } from '../queries/client.js';
import { chatServices } from '../services/chat-services.js';
import { ChatComposer } from '../views/chat-composer.js';
import { ChatView, type ChatViewProps } from '../views/chat-view.js';

function ChatRoot({ children }: { readonly children?: ReactNode }) {
  return (
    <StrictMode>
      <QueryClientProvider client={chatQueryClient}>
        <TooltipProvider>{children}</TooltipProvider>
      </QueryClientProvider>
    </StrictMode>
  );
}

export const ChatViewElement = defineReactElement<ChatViewProps>({
  props: ['projectId', 'threadId'],
  render: ChatView,
  wrap: () => ChatRoot,
});

export const ChatComposerElement = defineReactElement({
  props: [],
  render: () => <ChatComposer />,
  wrap: () => ChatRoot,
});

export const ChatThreadPanelElement = defineReactElement<ChatViewProps>({
  props: ['projectId', 'threadId'],
  render: (props) => <ChatView {...props} withFooter />,
  wrap: () => ChatRoot,
});

export const ChatGenericBlockElement = defineReactElement<{
  readonly block?: RenderBlock;
}>({
  props: ['block'],
  render: ({ block }) => <GenericBlock block={block} />,
});

/**
 * `<chat-readonly-markdown text>` (R-9.9): `ReadonlyMarkdown` with the
 * conversation's theme, for a block element drawn by another bundle.
 */
export const ChatReadonlyMarkdownElement = defineReactElement<{
  readonly text?: string;
}>({
  props: ['text'],
  render: ({ text }) => (
    <ReadonlyMarkdownView text={text ?? ''} theme={conversationTheme} />
  ),
});

/**
 * The Thread's tab mark, read from `runtime.records/v1` and kept current. A
 * Thread of a Project the mirror does not describe yet is looked up in that
 * Project's Threads, which starts their load.
 */
function RecordsThreadTabIcon({
  projectId,
  threadId,
}: {
  readonly projectId?: string;
  readonly threadId?: string;
}) {
  const records = chatServices().use(RuntimeRecordsV1);
  const thread = useSyncExternalStore(
    (listener) => {
      const subscription = records.subscribe(listener);
      return () => subscription.dispose();
    },
    () => {
      if (threadId === undefined) return undefined;
      const described = records.thread(threadId);
      if (described !== undefined || projectId === undefined) return described;
      return records
        .threads(projectId)
        .value?.find((candidate) => candidate.id === threadId);
    },
  );
  return <ThreadTabIcon thread={thread} />;
}

/**
 * `<chat-thread-tab-icon projectId threadId>` (bundle isolation 4a): the mark
 * of the Thread the records describe, which the layout draws on its tab.
 */
export const ChatThreadTabIconElement = defineReactElement<{
  readonly projectId?: string;
  readonly threadId?: string;
}>({
  props: ['projectId', 'threadId'],
  render: (props) => <RecordsThreadTabIcon {...props} />,
});
