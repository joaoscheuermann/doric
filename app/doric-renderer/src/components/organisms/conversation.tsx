import { CommentSelection } from '@/components/molecules/comment-selection';
import {
  type ConversationActions,
  ConversationActionsProvider,
} from '@/components/molecules/conversation-actions';
import {
  conversationNodes,
  markdownTheme,
} from '@/components/molecules/markdown-blocks';
import type {
  ConversationState,
  ConversationTurn,
} from '@/domain/conversation';
import type { Thread } from '@/domain/workspace';
import { useComposerShortcut } from '@/hooks/use-composer-shortcut';
import { useConversation } from '@/hooks/use-conversation';
import { useConversationDocument } from '@/hooks/use-conversation-document';
import { useComposerFocus } from '@/hooks/use-conversation-focus';
import { useEditKeys } from '@/hooks/use-edit-keys';
import { useFoldCommand } from '@/hooks/use-fold-command';
import { useSealedTurns } from '@/hooks/use-sealed-turns';
import { TRANSFORMERS } from '@lexical/markdown';
import { LexicalComposer } from '@lexical/react/LexicalComposer';
import { ContentEditable } from '@lexical/react/LexicalContentEditable';
import { LexicalErrorBoundary } from '@lexical/react/LexicalErrorBoundary';
import { MarkdownShortcutPlugin } from '@lexical/react/LexicalMarkdownShortcutPlugin';
import { RichTextPlugin } from '@lexical/react/LexicalRichTextPlugin';
import { MessageScroller } from '@shadcn/react/message-scroller';
import { type CSSProperties, useEffect, useRef } from 'react';

import userAvatar from '../../assets/user.png';

/**
 * The editor-side effects, which need the composer's context to run: the document
 * that follows the log, the rule that only the composer takes words, the shortcut
 * that sends what it holds, and the answer a fold's own head asks for.
 */
function ConversationPlugins({
  clear,
  state,
  threadId,
  turns,
}: {
  readonly clear: number;
  readonly state: ConversationState;
  readonly threadId: string;
  readonly turns: readonly ConversationTurn[];
}) {
  useConversationDocument(turns, state, clear);
  useComposerFocus(threadId);
  useSealedTurns();
  useComposerShortcut(state.editing);
  useEditKeys(state.editing);
  useFoldCommand();
  return null;
}

/**
 * The person's mark, as a CSS value: the image the app ships, drawn as a
 * background so nothing of it is a node of the document — it cannot be selected,
 * deleted or copied, and no name has to be invented to draw it. Every place the
 * person appears wears the same variable, which is why their avatar is the same
 * picture in a turn, in a comment's card, and in the field a comment is written
 * in.
 */
const avatarImage = (): string => `url('${String(userAvatar)}')`;

const initialEditorConfig = {
  namespace: 'DoricConversation',
  nodes: [...conversationNodes],
  onError(error: Error): void {
    throw error;
  },
  theme: markdownTheme,
};

/**
 * The Thread's conversation, as one Lexical document whose blocks are the turns:
 * the person's words, the agent's answer as it arrives, the reasoning behind it
 * and every tool call, with the composer last so the caret and the words being
 * typed live in the same document the durable log is rendered into.
 *
 * Its layout is a column of prose with the avatar beside each turn — shadcn's
 * tokens and the vendored serif for reading, and nothing that positions text by
 * hand.
 */
export function Conversation({
  onSandboxWrite,
  thread,
}: {
  readonly thread: Thread;
  readonly onSandboxWrite?: () => void;
}) {
  const conversation = useConversation(thread);
  /** The write count already reported, so a recount is not a new write. */
  const reported = useRef(conversation.writes);

  useEffect(() => {
    if (conversation.writes > reported.current) onSandboxWrite?.();
    reported.current = conversation.writes;
  }, [conversation.writes, onSandboxWrite]);

  const actions: ConversationActions = conversation.actions;
  const avatar = avatarImage() as CSSProperties['backgroundImage'];

  return (
    <section
      aria-label="Thread conversation"
      className="flex min-h-0 w-full flex-1 flex-col bg-background"
    >
      <MessageScroller.Provider autoScroll defaultScrollPosition="end">
        <MessageScroller.Root className="min-h-0 flex-1">
          <MessageScroller.Viewport aria-label="Conversation transcript">
            <MessageScroller.Content>
              <div
                className="doric-conversation pb-10"
                style={{ '--doric-avatar': avatar } as CSSProperties}
              >
                <LexicalComposer initialConfig={initialEditorConfig}>
                  <ConversationActionsProvider value={actions}>
                    <RichTextPlugin
                      contentEditable={
                        <ContentEditable
                          aria-label="Conversation"
                          className="outline-none"
                        />
                      }
                      ErrorBoundary={LexicalErrorBoundary}
                    />
                    <MarkdownShortcutPlugin transformers={TRANSFORMERS} />
                    <ConversationPlugins
                      clear={conversation.clear}
                      state={conversation.state}
                      threadId={thread.id}
                      turns={conversation.turns}
                    />
                    <CommentSelection addComment={conversation.addComment} />
                  </ConversationActionsProvider>
                </LexicalComposer>
              </div>
            </MessageScroller.Content>
          </MessageScroller.Viewport>
          <MessageScroller.Button />
        </MessageScroller.Root>
      </MessageScroller.Provider>

      {conversation.error === undefined ? null : (
        <p className="border-t px-4 py-2 text-sm text-destructive" role="alert">
          {conversation.error}
        </p>
      )}
    </section>
  );
}
