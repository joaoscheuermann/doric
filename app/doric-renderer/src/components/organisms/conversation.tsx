import { CommentSelection } from '@/components/molecules/comment-selection';
import {
  type ConversationActions,
  ConversationActionsProvider,
} from '@/components/molecules/conversation-actions';
import {
  conversationNodes,
  markdownTheme,
} from '@/components/molecules/markdown-blocks';
import { Button } from '@/components/ui/button';
import type {
  ConversationState,
  ConversationTurn,
} from '@/domain/conversation';
import type { Thread } from '@/domain/workspace';
import { useComposerShortcut } from '@/hooks/use-composer-shortcut';
import { useConversation } from '@/hooks/use-conversation';
import { useConversationDocument } from '@/hooks/use-conversation-document';
import { useComposerFocus } from '@/hooks/use-conversation-focus';
import { useComposerHeight } from '@/hooks/use-composer-height';
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
import { ArrowDownIcon } from 'lucide-react';
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
  /**
   * The element that learns the composer's height.
   *
   * It is the section and not `MessageScroller.Root` on purpose: the primitive
   * writes its own ref onto that div *before* spreading the props it was given,
   * so a `ref` passed here would land after it and replace the registration it
   * depends on. A custom property set on the section is inherited by the button
   * anyway, so the section is both the safe place to measure from and enough.
   */
  const frame = useRef<HTMLElement>(null);
  useComposerHeight(frame.current);

  return (
    <section
      aria-label="Thread conversation"
      className="flex min-h-0 w-full flex-1 flex-col bg-background"
      ref={frame}
    >
      <MessageScroller.Provider
        autoScroll
        defaultScrollPosition="end"
        // The primitive's own default is 8px, which reads as "one accidental
        // wheel notch and the thread stops following". Every chat that has tuned
        // this lands near the same buffer: MUI ships 150px, and a reader who has
        // nudged the scroll is still reading, not leaving. The same number
        // decides when the jump button appears, so the two agree by construction.
        scrollEdgeThreshold={150}
      >
        <MessageScroller.Root className="relative flex min-h-0 flex-1 flex-col">
          <MessageScroller.Viewport
            aria-label="Conversation transcript"
            className="min-h-0 flex-1 overflow-y-auto overscroll-contain"
          >
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
          <MessageScroller.Button
            direction="end"
            render={
              <Button
                aria-label="Jump to latest"
                // Sits above the pinned composer, not on top of it: a jump
                // control that covers the input is the one anti-pattern every
                // reference in the research names. The offset comes from the
                // composer's measured height rather than a guess, because the
                // composer is a line when empty and a paragraph once written.
                className="doric-jump absolute left-1/2 -translate-x-1/2 data-[active=false]:hidden"
                size="icon"
                variant="secondary"
              />
            }
          >
            <ArrowDownIcon />
          </MessageScroller.Button>
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
