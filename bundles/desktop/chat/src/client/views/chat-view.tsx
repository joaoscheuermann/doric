import { type Services, UiV1 } from 'bundle/contracts';
import { useMemo } from 'react';

import {
  ChatUiContext,
  Conversation,
} from '../components/organisms/conversation/index.js';
import { IntentDispatcher } from '../components/organisms/intent-dispatcher.js';
import { useComposer } from '../hooks/use-composer.js';
import { useMountHooks } from '../hooks/use-mount-hooks.js';
import { useThreadRecord } from '../hooks/use-thread-record.js';
import { chatServices } from '../services/chat-services.js';
import { ThreadComposer } from './chat-composer.js';

export type ChatViewProps = {
  readonly projectId?: string;
  readonly threadId?: string;
  readonly withFooter?: boolean;
};

/**
 * `<chat-view>`'s content (§7.4): the conversation of the Thread the route
 * names, opened on its record. Nothing is drawn until the record is known,
 * and the conversation is keyed by the Thread so another Thread is a new
 * editor, as the workspace keyed it.
 */
export function ChatView({
  projectId,
  threadId,
  services,
  withFooter = false,
}: ChatViewProps & { readonly services: Services }) {
  if (projectId === undefined || threadId === undefined) return null;
  return (
    <ChatThread
      projectId={projectId}
      threadId={threadId}
      services={services}
      withFooter={withFooter}
    />
  );
}

function ChatThread({
  projectId,
  threadId,
  services,
  withFooter,
}: {
  readonly projectId: string;
  readonly threadId: string;
  readonly services: Services;
  readonly withFooter: boolean;
}) {
  const thread = useThreadRecord(threadId);
  useMountHooks(projectId, threadId);
  const { promptSignal, sendRequest } = useComposer(threadId);
  // Block elements are created through the activation services: a call
  // through the element's services hands back a scoped view of any object
  // that carries methods, which an element is, so it would not be a node.
  const ui = useMemo(() => chatServices().use(UiV1), []);

  if (thread === undefined) return null;
  return (
    <ChatUiContext.Provider value={ui}>
      <IntentDispatcher services={services}>
        <div
          className="flex h-full min-h-0 min-w-0 flex-1 flex-col bg-background"
          data-chat-thread={threadId}
        >
          <Conversation
            autoFocus={!withFooter}
            key={thread.id}
            thread={thread}
            promptSignal={promptSignal}
            sendRequest={sendRequest}
          />
          {withFooter && (
            <footer
              className="flex chrome-bar shrink-0 items-center justify-end border-t bg-sidebar px-2"
              data-slot="chat-thread-footer"
            >
              <ThreadComposer thread={thread} />
            </footer>
          )}
        </div>
      </IntentDispatcher>
    </ChatUiContext.Provider>
  );
}
