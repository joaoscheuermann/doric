// The comments one user turn wears, as one stable, non-editable block that
// stands directly above the reader's own words: the same lines the stack drew
// before the send, now durable — drawn by the same element (`CommentLine`),
// with the target the comment's own `comments.added/v1` payload carries and
// the pin's number from the turn's own order. Nothing edits here: a sent
// comment is immutable until a new event says otherwise. The line draws no
// state of its own: the thread's state and the agent's replies are read out to
// a screen reader only, from the conversation's comment threads, so they follow
// later replies and resolutions live.
//
// Each line is a button: it opens the comment's thread on the latest drawing
// of its target — the conversation's latest block of that target is shown,
// and `COMMENT_THREAD_OPEN_EVENT` goes out without a revision.
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
import type { JSX } from 'react';

import type { TurnComment } from '../../../../../contracts/index.js';
import {
  agentReplies,
  rootIdOf,
  threadState,
} from '../../../../domain/comment-threads.js';
import { TURN_COMMENTS_BLOCK } from '../../../../domain/conversation-nodes.js';
import { useCommentThreads } from '../../../../hooks/use-comment-threads.js';
import { openCommentThread } from '../../../../utility/comment-thread.js';
import {
  CommentLine,
  type CommentLineItem,
  commentLineLabel,
} from '../../../molecules/comment-line.js';
import { markerLabel } from '../../../molecules/comment-marker.js';

/** One sent comment's line; pressing it opens the thread on the target's latest drawing. */
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
  const state =
    thread === undefined
      ? undefined
      : markerLabel(threadState(thread), agentReplies(thread));

  return (
    <button
      type="button"
      title="Open thread"
      aria-label={`Open thread: ${commentLineLabel(item)}${state === undefined ? '' : `, ${state}`}`}
      className="block w-full cursor-pointer rounded-md text-left transition-colors hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring"
      onClick={(event) =>
        openCommentThread(event.currentTarget, {
          commentId: rootId,
          target: thread?.target ?? comment.target,
        })
      }
    >
      <CommentLine item={item} />
    </button>
  );
}

type SerializedCommentLinesNode = Spread<
  { promptId: string; comments: readonly TurnComment[] },
  SerializedLexicalNode
>;

/** The comments of one user turn, above the words the reader sent. */
export class CommentLinesNode extends DecoratorNode<JSX.Element> {
  __promptId: string;
  __comments: readonly TurnComment[] = [];

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
  }

  override createDOM(): HTMLElement {
    const dom = document.createElement('div');
    dom.dataset.turnComments = '';
    dom.contentEditable = 'false';
    return dom;
  }

  override updateDOM(): boolean {
    return false;
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
      <section
        key={`${this.__promptId}:${this.__comments.length}`}
        aria-label="Comments"
        className="mb-3 flex flex-col gap-0.5 font-conversation text-sm font-light"
      >
        {this.__comments.map((comment, index) => (
          <div key={comment.commentId} className="-mx-2.5">
            <TurnCommentLine comment={comment} pin={index + 1} />
          </div>
        ))}
      </section>
    );
  }

  override exportJSON(): SerializedCommentLinesNode {
    return {
      ...super.exportJSON(),
      promptId: this.__promptId,
      comments: [...this.__comments],
    };
  }

  static override importJSON(
    value: SerializedCommentLinesNode,
  ): CommentLinesNode {
    const node = new CommentLinesNode(value.promptId);
    node.__comments = [...value.comments];

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
