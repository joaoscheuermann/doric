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
import { useComposerHeight } from '@/hooks/use-composer-height';
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
   * The element the composer's height is measured from.
   *
   * It is the element the jump button sticks to — the scrolling viewport, which is
   * an ancestor of the button — so the custom property the measurement is written
   * on is inherited by the one control that reads it, and nothing else is asked to
   * know about the composer at all.
   */
  const viewport = useRef<HTMLDivElement>(null);
  useComposerHeight(viewport.current);

  return (
    <section
      aria-label="Thread conversation"
      className="flex min-h-0 w-full flex-1 flex-col bg-background"
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
          {/*
           * The scroll container is its own layer, and the root only positions the
           * control over it, because a sticky descendant cannot escape the
           * viewport's own clipping: the button belongs to the element that scrolls,
           * and the button is what watches the composer's height to know how much
           * room to stand clear of.
           */}
          <MessageScroller.Viewport
            aria-label="Conversation transcript"
            className="relative min-h-0 flex-1 overflow-y-auto overscroll-contain"
            ref={viewport}
          >
            <MessageScroller.Content>
              <div
                className="doric-conversation"
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
          </MessageScroller.Viewport>
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
