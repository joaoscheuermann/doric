/**
 * The agent's answers to the reader's comments, as a block of its turn, where
 * it wrote them (`comment_reply`, whose own tool row this block replaces).
 * Each answer is one row, drawn the way a tool call is: `Replied to [n]` and
 * the note it answers, the chevron, and at the right end the thread's state as
 * one glyph (`✓` resolved, `?` waiting for the reader, `…` open); opened, the
 * agent's words as the conversation's Markdown, behind the guide line.
 *
 * The state is the thread's now, not the reply's: it is read from the
 * conversation's comment threads, so a later resolution or reply changes it in
 * place. A row is folded while its thread is resolved and open otherwise,
 * until the reader opens or closes it (`replyOpenness`). The glyph opens the
 * thread on the latest drawing of the comment's target (`openCommentThread`).
 */

import {
  $getNodeByKey,
  DecoratorNode,
  type LexicalEditor,
  type LexicalNode,
  type NodeKey,
  type SerializedLexicalNode,
  type Spread,
} from 'lexical';
import type { JSX } from 'react/jsx-runtime';

import { replyOpenness } from '../../../../domain/collapsible.js';
import { threadState } from '../../../../domain/comment-threads.js';
import { REPLIES_TURN_BLOCK } from '../../../../domain/conversation-nodes.js';
import type {
  CommentReply,
  RepliesTurn,
} from '../../../../domain/projector.js';
import { useCommentThreads } from '../../../../hooks/use-comment-threads.js';
import { CollapsibleBlock } from '../../../molecules/collapsible-block.js';
import { CommentThreadPin } from '../../../molecules/comment-thread-pin.js';
import { WidgetFocus } from '../../../molecules/widget-focus.js';
import { ReadonlyMarkdown } from '../readonly-markdown.js';
import { CONVERSATION_FONT_CLASS } from './conversation-font.js';

export type SerializedRepliesTurnNode = Spread<
  { turnKey: string; promptId: string; replies: readonly CommentReply[] },
  SerializedLexicalNode
>;

/** The reader's choice of open/closed per reply, by the reply's comment id. */
type ChosenReplies = Readonly<Record<string, boolean>>;

/** One answer of the agent, as its row. */
function ReplyRow({
  reply,
  chosen,
  focused,
  onChosenChange,
}: {
  readonly reply: CommentReply;
  readonly chosen: boolean | null;
  readonly focused: boolean;
  readonly onChosenChange: (chosen: boolean) => void;
}) {
  const threads = useCommentThreads();
  const thread = threads.get(reply.rootId);
  const state = thread === undefined ? 'open' : threadState(thread);
  const target = thread?.target ?? reply.reply.target;
  const pin = reply.asked?.pin ?? thread?.messages[0]?.pin;
  const note = reply.asked?.text.trim() ?? '';

  return (
    <div
      data-reply-root={reply.rootId}
      data-reply-id={reply.reply.commentId}
      data-comment-state={state}
    >
      <CollapsibleBlock
        chosen={chosen}
        focused={focused}
        openness={replyOpenness(state, reply.reply.text)}
        onChosenChange={onChosenChange}
        toggleLabel={`Replied to: ${note}`}
        label={
          <span className="flex min-w-0 items-center gap-1">
            <span className="shrink-0 font-normal">Replied to:</span>
            {note.length > 0 && (
              <span className="min-w-0 truncate font-light">{note}</span>
            )}
          </span>
        }
        trailing={
          pin === undefined ? undefined : (
            <CommentThreadPin
              pin={pin}
              state={state}
              thread={thread}
              target={target}
              rootId={reply.rootId}
            />
          )
        }
      >
        <ReadonlyMarkdown text={reply.reply.text} />
      </CollapsibleBlock>
    </div>
  );
}

/** One block of the agent's comment replies. */
export class RepliesTurnNode extends DecoratorNode<JSX.Element> {
  __turnKey: string;
  __promptId: string;
  __replies: readonly CommentReply[];
  /** The reader's choice of open/closed per row; absent until they make one. */
  __chosen: ChosenReplies = {};

  constructor(
    turnKey: string,
    promptId: string,
    replies: readonly CommentReply[],
    key?: NodeKey,
  ) {
    super(key);
    this.__turnKey = turnKey;
    this.__promptId = promptId;
    this.__replies = replies;
  }

  static override getType(): string {
    return REPLIES_TURN_BLOCK;
  }

  static override clone(node: RepliesTurnNode): RepliesTurnNode {
    return new RepliesTurnNode(
      node.__turnKey,
      node.__promptId,
      node.__replies,
      node.__key,
    );
  }

  /**
   * The reader's choices of open/closed are theirs, not the sync's: they travel
   * with the block through every update a sync writes.
   */
  override afterCloneFrom(prevNode: this): void {
    super.afterCloneFrom(prevNode);
    this.__chosen = prevNode.__chosen;
  }

  override createDOM(): HTMLElement {
    const dom = document.createElement('div');
    dom.className = `mt-6 ${CONVERSATION_FONT_CLASS}`;
    return dom;
  }

  override updateDOM(): boolean {
    return false;
  }

  /** A block, not an inline widget (see `FailureTurnNode.isInline`). */
  override isInline(): boolean {
    return false;
  }

  override decorate(editor: LexicalEditor): JSX.Element {
    return (
      <WidgetFocus nodeKey={this.__key}>
        {(focused) => (
          <div className="flex flex-col gap-2" data-comment-replies="">
            {this.__replies.map((reply) => (
              <ReplyRow
                key={reply.reply.commentId}
                reply={reply}
                chosen={this.__chosen[reply.reply.commentId] ?? null}
                focused={focused}
                onChosenChange={(chosen) =>
                  editor.update(() => {
                    const node = $getNodeByKey(this.__key);
                    if ($isRepliesTurnNode(node))
                      node.setChosen(reply.reply.commentId, chosen);
                  })
                }
              />
            ))}
          </div>
        )}
      </WidgetFocus>
    );
  }

  /** Write the reader's choice of open/closed for one reply's row. */
  setChosen(commentId: string, chosen: boolean): void {
    if (this.__chosen[commentId] === chosen) return;
    const writable = this.getWritable();
    writable.__chosen = { ...writable.__chosen, [commentId]: chosen };
  }

  /** Take the chat's latest reading of the block: a reply joined it. */
  setTurn(turn: RepliesTurn): void {
    if (
      this.__replies.length === turn.replies.length &&
      this.__replies.every(
        (reply, index) =>
          reply.reply.commentId === turn.replies[index]?.reply.commentId,
      )
    )
      return;
    this.getWritable().__replies = turn.replies;
  }

  override exportJSON(): SerializedRepliesTurnNode {
    return {
      ...super.exportJSON(),
      turnKey: this.__turnKey,
      promptId: this.__promptId,
      replies: [...this.__replies],
    };
  }

  static override importJSON(
    serialized: SerializedRepliesTurnNode,
  ): RepliesTurnNode {
    return $createRepliesTurnNode(
      serialized.turnKey,
      serialized.promptId,
      serialized.replies,
    );
  }
}

export function $createRepliesTurnNode(
  turnKey: string,
  promptId: string,
  replies: readonly CommentReply[],
): RepliesTurnNode {
  return new RepliesTurnNode(turnKey, promptId, replies);
}

export function $isRepliesTurnNode(
  node: LexicalNode | null | undefined,
): node is RepliesTurnNode {
  return node instanceof RepliesTurnNode;
}
