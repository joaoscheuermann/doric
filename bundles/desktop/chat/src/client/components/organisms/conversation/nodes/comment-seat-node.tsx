// The inline comment seat: the block typing over a selection opens where the
// note about the selected words is written and edited. It stands inside the
// agent turn — after a block, or at the end of a list item — and holds the
// words the selection quoted — the passage the transcript keeps highlighted
// (`plugins/comment-highlights.tsx`) — while the comment itself is drawn by
// `CommentEntry`, the one element it is from the first character to the send.
//
// A seat is one comment, named by the comment's id (`comment-<uuid>`, the stack
// item's own), so a paragraph can hold several. It names the turn it belongs
// to, the 0-based block its words start in and how far into it (the highlight's
// way to them), and where it stands: after the block that holds the end of its
// words (`after`) or, when that block is a list, at the end of the item that
// does (`item`). A turn rebuilt from a delta puts it back there, in passage
// order among that place's seats (`$placeSeats` in `agent-turn-node.tsx`).

import {
  DecoratorNode,
  type LexicalNode,
  type NodeKey,
  type SerializedLexicalNode,
  type Spread,
} from 'lexical';
import type { JSX } from 'react';

import { COMMENT_SEAT_BLOCK } from '../../../../domain/conversation-nodes.js';
import { CommentEntry } from '../../comment-entry.js';

/**
 * What the seat hands the entry: the block it stands after, the words it
 * quotes, and the one gesture the entry reports back — the comment removed.
 */
export interface CommentSeatBlock {
  /** The comment's id: the stack item's, from the seat's first moment. */
  readonly id: string;
  readonly promptId: string;
  readonly turn: string;
  readonly block: number;
  readonly quote: string;
  /** How far into its block the quoted words start, whitespace aside. */
  readonly at: number;
  /** The block the seat stands after, or in when it is a list. */
  readonly after: number;
  /** The item of that list the seat closes, when it stands in a list. */
  readonly item: number | undefined;
  /** The item of `block` the words start in, when that block is a list. */
  readonly startItem: number | undefined;
  /** Removes the seat, and the highlight of the words it quotes with it. */
  discard(): void;
}

export type SerializedCommentSeatNode = Spread<
  {
    id: string;
    promptId: string;
    turn: string;
    block: number;
    quote: string;
    at: number;
    after?: number;
    item?: number;
    startItem?: number;
  },
  SerializedLexicalNode
>;

/**
 * One comment on a passage of an agent's answer, at the end of the block (or
 * list item) its words end in.
 */
export class CommentSeatNode
  extends DecoratorNode<JSX.Element>
  implements CommentSeatBlock
{
  __id: string;
  __promptId: string;
  __turn: string;
  __block: number;
  __quote: string;
  /**
   * How far into its block the quoted words start, in characters that are not
   * whitespace, so the highlight finds the occurrence the reader selected.
   */
  __at: number;
  /** The block the seat stands after (or in, for a list); `__block` by default. */
  __after: number;
  /** The list item the seat closes, when it stands in a list. */
  __item: number | undefined;
  /** The item of `__block` the words start in, when that block is a list. */
  __startItem: number | undefined;

  constructor(
    id: string,
    promptId: string,
    block: number,
    quote: string,
    key?: NodeKey,
  ) {
    super(key);
    this.__id = id;
    this.__promptId = promptId;
    this.__turn = '';
    this.__block = block;
    this.__quote = quote;
    this.__at = 0;
    this.__after = block;
    this.__item = undefined;
    this.__startItem = undefined;
  }

  static override getType(): string {
    return COMMENT_SEAT_BLOCK;
  }

  static override clone(node: CommentSeatNode): CommentSeatNode {
    const copy = new CommentSeatNode(
      node.__id,
      node.__promptId,
      node.__block,
      node.__quote,
      node.__key,
    );
    copy.__turn = node.__turn;
    copy.__at = node.__at;
    copy.__after = node.__after;
    copy.__item = node.__item;
    copy.__startItem = node.__startItem;

    return copy;
  }

  override createDOM(): HTMLElement {
    const dom = document.createElement('div');
    dom.dataset.commentSeat = '';
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
    // The entry is an editing host of its own, which the caret reaches by
    // focusing it, never as a stop of the editor.
    return false;
  }

  get id(): string {
    return this.__id;
  }

  get promptId(): string {
    return this.__promptId;
  }

  get turn(): string {
    return this.__turn;
  }

  get block(): number {
    return this.__block;
  }

  get quote(): string {
    return this.__quote;
  }

  /** How far into its block the quoted words start; see `__at`. */
  get at(): number {
    return this.__at;
  }

  /** The block the seat stands after, or in when it is a list. */
  get after(): number {
    return this.__after;
  }

  /** The list item the seat closes, when it stands in a list. */
  get item(): number | undefined {
    return this.__item;
  }

  /** The item of `block` the words start in, when that block is a list. */
  get startItem(): number | undefined {
    return this.__startItem;
  }

  /** The comment was removed: the seat leaves the transcript. */
  discard(): void {
    this.remove();
  }

  override decorate(): JSX.Element {
    return <CommentEntry seat={this} />;
  }

  override exportJSON(): SerializedCommentSeatNode {
    return {
      ...super.exportJSON(),
      id: this.__id,
      promptId: this.__promptId,
      turn: this.__turn,
      block: this.__block,
      quote: this.__quote,
      at: this.__at,
      after: this.__after,
      ...(this.__item === undefined ? {} : { item: this.__item }),
      ...(this.__startItem === undefined
        ? {}
        : { startItem: this.__startItem }),
    };
  }

  static override importJSON(
    value: SerializedCommentSeatNode,
  ): CommentSeatNode {
    const node = new CommentSeatNode(
      value.id,
      value.promptId,
      value.block,
      value.quote,
    );
    node.__turn = value.turn;
    node.__at = value.at;
    node.__after = value.after ?? value.block;
    node.__item = value.item;
    node.__startItem = value.startItem;

    return node;
  }
}

export function $createCommentSeatNode(seat: {
  readonly id: string;
  readonly promptId: string;
  readonly turn: string;
  readonly block: number;
  readonly quote: string;
  readonly at: number;
  readonly after?: number;
  readonly item?: number;
  readonly startItem?: number;
}): CommentSeatNode {
  const node = new CommentSeatNode(
    seat.id,
    seat.promptId,
    seat.block,
    seat.quote,
  );
  node.__turn = seat.turn;
  node.__at = seat.at;
  node.__after = seat.after ?? seat.block;
  node.__item = seat.item;
  node.__startItem = seat.startItem;

  return node;
}

export function $isCommentSeatNode(
  node: LexicalNode | null | undefined,
): node is CommentSeatNode {
  return node instanceof CommentSeatNode;
}
