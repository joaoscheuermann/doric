// The comments one user turn wears, as one stable, non-editable block that
// opens the turn, above the reader's own words: the same comment group the
// stack drew inside the prompt before the send (`CommentGroup`), now durable —
// an `N comments` header beside the reader's mark, then one card per comment
// (`CommentLine`) with the passage it is about — with the target the comment's
// own `comments.added/v1` payload carries and the pin's number from the turn's
// own order. The block wears the mark its turn would wear (the sync hands it
// over), and the turn block below it then wears none (`styles.css`). Nothing
// edits here: a sent comment is immutable until a new event says otherwise.
// The card draws no state of its own: the thread's state and the agent's
// replies are read out to a screen reader only, from the conversation's
// comment threads, so they follow later replies and resolutions live.
//
// The passage is the anchor's quote (`comments.added/v1` carries the same
// target the prompt's `<comments>` envelope names), read in the paragraph of
// the answer it was selected from when the anchor names its turn and block and
// the transcript still draws them (`useBlockText`); else the quote alone.
//
// Each card's arrow (and a press on the card) goes to the comment's passage
// (`useGoToComment`): a comment on the agent's answer reveals its paragraph;
// any other opens the comment's thread on the latest drawing of its target —
// the conversation's latest block of that target is shown, and
// `COMMENT_THREAD_OPEN_EVENT` goes out without a revision.
//
// The sync (`insert-thread-turn-nodes.tsx`) seats it right before the user
// turn block; the node only holds the comments it draws, which come from the
// projection of the log.

import {
  DecoratorNode,
  type LexicalNode,
  type NodeKey,
  type SerializedLexicalNode,
  type Spread,
} from 'lexical';
import { type JSX, useState } from 'react';

import {
  MESSAGE_KIND,
  type TurnComment,
} from '../../../../../contracts/index.js';
import {
  anchorBlock,
  commentExcerpt,
} from '../../../../domain/comment-excerpt.js';
import {
  agentReplies,
  rootIdOf,
  threadState,
} from '../../../../domain/comment-threads.js';
import { targetKey } from '../../../../domain/composer-stack.js';
import { TURN_COMMENTS_BLOCK } from '../../../../domain/conversation-nodes.js';
import { useBlockText } from '../../../../hooks/use-block-text.js';
import { useCommentThreads } from '../../../../hooks/use-comment-threads.js';
import { useGoToComment } from '../../../../hooks/use-go-to-comment.js';
import {
  CommentLine,
  type CommentLineItem,
  commentLineLabel,
  GO_TO_LABEL,
} from '../../../molecules/comment-line.js';
import { markerLabel } from '../../../molecules/comment-marker.js';
import { CommentGroup } from '../../comment-group.js';
import {
  applyTurnAvatar,
  sameTurnAvatar,
  type TurnAvatar,
} from './turn-avatar.js';

/** One sent comment's card; its arrow, or a press on it, goes to the comment's passage. */
function TurnCommentLine({
  comment,
  pin,
}: {
  readonly comment: TurnComment;
  readonly pin: number;
}) {
  const threads = useCommentThreads();
  const rootId = rootIdOf(comment);
  const thread = threads.get(rootId);
  const item: CommentLineItem = {
    author: comment.author,
    note: comment.text,
    target: comment.target,
    pin,
    reply: comment.inReplyTo !== undefined,
  };
  const block = anchorBlock(comment.target);
  const paragraph = useBlockText(block);
  const state =
    thread === undefined
      ? undefined
      : markerLabel(threadState(thread), agentReplies(thread));
  const goTo = useGoToComment();
  const onGo = (from: HTMLElement): void =>
    goTo(from, {
      id: comment.commentId,
      thread: rootId,
      target: thread?.target ?? comment.target,
      ...(block === undefined ? {} : { block }),
    });

  return (
    // The press on the card goes where its arrow does; the arrow is the
    // keyboard's way there, so the card itself is no second control.
    // biome-ignore lint/a11y/noStaticElementInteractions: the card's arrow is its keyboard control
    // biome-ignore lint/a11y/useKeyWithClickEvents: the card's arrow is its keyboard control
    <div
      // A comment on the answer's words goes to them; any other opens its thread.
      title={
        targetKey(comment.target)?.kind === MESSAGE_KIND
          ? GO_TO_LABEL
          : 'Open thread'
      }
      className="cursor-pointer rounded-md transition-colors hover:bg-muted"
      onClick={(event) => onGo(event.currentTarget)}
    >
      <CommentLine
        item={item}
        excerpt={commentExcerpt(comment.target, paragraph)}
        onGo={onGo}
      />
      <span data-comment-spoken="" className="sr-only">
        {`${commentLineLabel(item)}${state === undefined ? '' : `, ${state}`}`}
      </span>
    </div>
  );
}

/** The comment group of one user turn, open until the reader folds it. */
function TurnComments({
  comments,
}: {
  readonly comments: readonly TurnComment[];
}) {
  const [open, setOpen] = useState(true);

  return (
    <CommentGroup
      count={comments.length}
      open={open}
      onOpenChange={setOpen}
      label="Comments"
    >
      <ol className="flex flex-col gap-1.5">
        {comments.map((comment, index) => (
          <li key={comment.commentId} className="min-w-0">
            <TurnCommentLine comment={comment} pin={index + 1} />
          </li>
        ))}
      </ol>
    </CommentGroup>
  );
}

type SerializedCommentLinesNode = Spread<
  {
    promptId: string;
    comments: readonly TurnComment[];
    avatar?: TurnAvatar;
  },
  SerializedLexicalNode
>;

/** The comments of one user turn, above the words the reader sent. */
export class CommentLinesNode extends DecoratorNode<JSX.Element> {
  __promptId: string;
  __comments: readonly TurnComment[] = [];
  /** The mark of the turn the comments open, worn in its place. */
  __avatar: TurnAvatar = null;

  constructor(promptId: string, key?: NodeKey) {
    super(key);
    this.__promptId = promptId;
  }

  static override getType(): string {
    return TURN_COMMENTS_BLOCK;
  }

  static override clone(node: CommentLinesNode): CommentLinesNode {
    return new CommentLinesNode(node.__promptId, node.__key);
  }

  override afterCloneFrom(previous: this): void {
    super.afterCloneFrom(previous);
    this.__comments = previous.__comments;
    this.__avatar = previous.__avatar;
  }

  override createDOM(): HTMLElement {
    const dom = document.createElement('div');
    dom.dataset.turnComments = '';
    dom.contentEditable = 'false';
    applyTurnAvatar(dom, this.__avatar);
    return dom;
  }

  /**
   * The mark is written again in place, keeping the element it drew, and only
   * when it changed.
   */
  override updateDOM(prevNode: this, dom: HTMLElement): boolean {
    if (!sameTurnAvatar(prevNode.__avatar, this.__avatar))
      applyTurnAvatar(dom, this.__avatar);
    return false;
  }

  /** Wears the mark of the turn the comments open; the sync hands it over. */
  setAvatar(avatar: TurnAvatar): void {
    if (sameTurnAvatar(this.getLatest().__avatar, avatar)) return;
    this.getWritable().__avatar = avatar;
  }

  override isInline(): boolean {
    return false;
  }

  override isKeyboardSelectable(): boolean {
    // The lines are read, not written; the caret has nothing to say here.
    return false;
  }

  /** Sets the comments this turn wears, in the order the log wrote them. */
  setComments(comments: readonly TurnComment[]): void {
    const previous = this.getLatest();

    if (
      comments.length === previous.__comments.length &&
      comments.every(
        (comment, index) =>
          comment.commentId === previous.__comments[index]?.commentId,
      )
    ) {
      return;
    }

    this.getWritable().__comments = comments;
  }

  override decorate(): JSX.Element {
    return (
      <TurnComments
        key={`${this.__promptId}:${this.__comments.length}`}
        comments={this.__comments}
      />
    );
  }

  override exportJSON(): SerializedCommentLinesNode {
    return {
      ...super.exportJSON(),
      promptId: this.__promptId,
      comments: [...this.__comments],
      ...(this.__avatar === null ? {} : { avatar: this.__avatar }),
    };
  }

  static override importJSON(
    value: SerializedCommentLinesNode,
  ): CommentLinesNode {
    const node = new CommentLinesNode(value.promptId);
    node.__comments = [...value.comments];
    node.__avatar = value.avatar ?? null;

    return node;
  }
}

export function $createCommentLinesNode(
  promptId: string,
  comments: readonly TurnComment[] = [],
): CommentLinesNode {
  const node = new CommentLinesNode(promptId);
  node.__comments = comments;

  return node;
}

export function $isCommentLinesNode(
  node: LexicalNode | null | undefined,
): node is CommentLinesNode {
  return node instanceof CommentLinesNode;
}
