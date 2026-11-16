import { type Services, UiV1 } from 'bundle/contracts';
import { type CSSProperties, useMemo } from 'react';

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

/**
 * The viewer footer band's geometry (conversation-footer spec, D2 and D13): a
 * 44 px band floating over the conversation's bottom, 8 px over and under its
 * 28 px row. Its height, fill and blur are chat's sheet rule, keyed on its
 * `data-slot`; the height reads `--chat-footer-height`.
 */
const FOOTER_BAND =
  'absolute inset-x-0 bottom-0 flex items-center justify-end gap-1 py-2 pl-2 text-[11px] font-normal';

/**
 * `--chat-footer-height` for the band's parent: the band's 44 px, which the
 * sheet rule reads as its height.
 */
const FOOTER_HEIGHT = { '--chat-footer-height': '2.75rem' } as CSSProperties;

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
  const { promptSignal, sendRequest } = useComposer(thread);
  // Block elements are created through the activation services: a call
  // through the element's services hands back a scoped view of any object
  // that carries methods, which an element is, so it would not be a node.
  const ui = useMemo(() => chatServices().use(UiV1), []);

  if (thread === undefined) return null;
  return (
    <ChatUiContext.Provider value={ui}>
      <IntentDispatcher services={services}>
        <div
          className="relative flex h-full min-h-0 min-w-0 flex-1 flex-col bg-background"
          data-chat-thread={threadId}
          style={withFooter ? FOOTER_HEIGHT : undefined}
        >
          <Conversation
            autoFocus={!withFooter}
            key={thread.id}
            thread={thread}
            promptSignal={promptSignal}
            sendRequest={sendRequest}
          />
          {withFooter && (
            <footer className={FOOTER_BAND} data-slot="chat-thread-footer">
              <ThreadComposer thread={thread} />
            </footer>
          )}
        </div>
      </IntentDispatcher>
    </ChatUiContext.Provider>
  );
}
