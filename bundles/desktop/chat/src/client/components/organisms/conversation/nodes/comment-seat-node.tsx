// The inline comment seat: the block a selection opens after the paragraph it
// starts in, where the note about the selected words is written. It stands
// inside the agent turn, after its own block, and holds the words the selection
// quoted — the entry itself is drawn by `CommentEntry`, beside the composer's
// stack.
//
// The seat names the turn it belongs to and the 0-based block it follows, so a
// turn rebuilt from a delta can put it back after the same paragraph
// (`$placeSeats` in `agent-turn-node.tsx`).

import {
  DecoratorNode,
  type ElementNode,
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
 * quotes, and the two gestures the entry reports back — the note committed, the
 * draft discarded.
 */
export interface CommentSeatBlock {
  readonly promptId: string;
  readonly turn: string;
  readonly block: number;
  readonly quote: string;
  /** Whether the entry is still open for writing; a commit closes it. */
  readonly open: boolean;
  onCommit(): void;
  onDiscard(): void;
}

export type SerializedCommentSeatNode = Spread<
  {
    promptId: string;
    turn: string;
    block: number;
    quote: string;
    open: boolean;
  },
  SerializedLexicalNode
>;

/** The comment entry of one paragraph of an agent's answer. */
export class CommentSeatNode
  extends DecoratorNode<JSX.Element>
  implements CommentSeatBlock
{
  __promptId: string;
  __turn: string;
  __block: number;
  __quote: string;
  /** Whether the entry is still open for writing; a commit closes it. */
  __open: boolean;
  /**
   * The turn the seat was opened in, kept so it can name its parent while no
   * editor state is being read — a replay's check, a caller outside the editor.
   * Inside an update the editor's own tree answers.
   */
  __owner: ElementNode | null;

  constructor(promptId: string, block: number, quote = '', key?: NodeKey) {
    super(key);
    this.__promptId = promptId;
    this.__turn = '';
    this.__block = block;
    this.__quote = quote;
    this.__open = true;
    this.__owner = null;
  }

  static override getType(): string {
    return COMMENT_SEAT_BLOCK;
  }

  static override clone(node: CommentSeatNode): CommentSeatNode {
    const copy = new CommentSeatNode(
      node.__promptId,
      node.__block,
      node.__quote,
      node.__key,
    );
    copy.__turn = node.__turn;
    copy.__open = node.__open;
    copy.__owner = node.__owner;

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

  /**
   * A seat with a parent stands in the editor's tree. The base walk reads the
   * editor's node map, which only answers inside a read.
   */
  override isAttached(): boolean {
    return this.__parent !== null;
  }

  /** The turn the seat stands in; the editor's own tree answers inside a read. */
  override getParent(): ElementNode | null {
    try {
      return super.getParent();
    } catch {
      return this.__owner;
    }
  }

  /**
   * Names the turn the seat stands in, so the seat can answer for its parent
   * while no editor state is being read.
   */
  setOwner(turn: ElementNode): void {
    if (this.__owner !== null) return;
    this.__owner = turn;
  }

  override isKeyboardSelectable(): boolean {
    // The entry is an editing host of its own, which the caret reaches by
    // focusing it, never as a stop of the editor.
    return false;
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

  /** Whether the entry is still open for writing. */
  get open(): boolean {
    return this.__open;
  }

  /** Names the turn the seat belongs to; the turn sets it when it opens one. */
  setTurn(turn: string): void {
    if (this.__turn === turn) return;
    this.getWritable().__turn = turn;
  }

  /** Replaces the words the seat quotes, as a new selection asks. */
  setQuote(quote: string): void {
    if (this.__quote === quote) return;
    this.getWritable().__quote = quote;
  }

  /** Opens or closes the entry; a commit closes it, a new selection reopens it. */
  setOpen(open: boolean): void {
    if (this.__open === open) return;
    this.getWritable().__open = open;
  }

  onCommit(): void {
    this.setOpen(false);
  }

  /** The draft left the seat: the entry closes and the seat goes with it. */
  onDiscard(): void {
    this.remove();
  }

  override decorate(): JSX.Element {
    return <CommentEntry seat={this} />;
  }

  override exportJSON(): SerializedCommentSeatNode {
    return {
      ...super.exportJSON(),
      promptId: this.__promptId,
      turn: this.__turn,
      block: this.__block,
      quote: this.__quote,
      open: this.__open,
    };
  }

  static override importJSON(
    value: SerializedCommentSeatNode,
  ): CommentSeatNode {
    const node = new CommentSeatNode(value.promptId, value.block, value.quote);
    node.__turn = value.turn;
    node.__open = value.open;

    return node;
  }
}

export function $createCommentSeatNode(
  promptId: string,
  block: number,
  quote?: string,
): CommentSeatNode {
  return new CommentSeatNode(promptId, block, quote);
}

export function $isCommentSeatNode(
  node: LexicalNode | null | undefined,
): node is CommentSeatNode {
  return node instanceof CommentSeatNode;
}
