import {
  $applyNodeReplacement,
  DecoratorNode,
  type LexicalNode,
  type NodeKey,
  type SerializedLexicalNode,
  type Spread,
} from 'lexical';
import type { ReactElement } from 'react';

import { CommentCard } from './comment-card';
import { CommentField } from './comment-field';

/**
 * The two blocks a comment adds to the document: the field a person writes one
 * in, and the card that shows it once it belongs to a turn.
 *
 * Both are block decorators, never inline: a decoration inside a paragraph would
 * become a caret stop in the middle of the prose. Their DOM is not editable and
 * not selected with the words beside it, so neither can be typed into or dragged
 * along with a selection. What they *do* — write a body, remove a comment — is
 * not a node property, because a node carries data only; it is read from the
 * actions context inside the component instead.
 */

/**
 * The pending comment a person is writing: a field the surface shows where the
 * commented span is. It carries the comment it edits and whether the surface
 * wants its input focused, and nothing else — the words live in the surface, not
 * in the document.
 */
export class CommentFieldNode extends DecoratorNode<ReactElement> {
  __commentId: string;
  __focused: boolean;

  static override getType(): string {
    return 'doric-comment-field';
  }

  static override clone(node: CommentFieldNode): CommentFieldNode {
    return new CommentFieldNode(node.__commentId, node.__focused, node.__key);
  }

  /** A field from JSON carries nothing: the surface rebuilds it with its comment. */
  static override importJSON(): CommentFieldNode {
    return $createCommentFieldNode('');
  }

  constructor(commentId: string, focused = false, key?: NodeKey) {
    super(key);
    this.__commentId = commentId;
    this.__focused = focused;
  }

  getCommentId(): string {
    return this.getLatest().__commentId;
  }

  isFocused(): boolean {
    return this.getLatest().__focused;
  }

  setFocused(value: boolean): this {
    const node = this.getWritable();
    node.__focused = value;
    return node;
  }

  override createDOM(): HTMLElement {
    const dom = document.createElement('div');
    dom.className = 'doric-comment-field';
    // The field holds an input, which is editable on its own terms; the block
    // around it is not, so the prose caret has no position to stop in.
    dom.contentEditable = 'false';
    return dom;
  }

  /** The field owns an input, so its element is never rebuilt. */
  override updateDOM(): false {
    return false;
  }

  override decorate(): ReactElement {
    return (
      <CommentField
        commentId={this.getCommentId()}
        autoFocus={this.isFocused()}
      />
    );
  }

  /** A block decorator: an inline one would be a caret stop inside prose. */
  override isInline(): false {
    return false;
  }
}

/** A comment's quote and body, as the card in a person's turn reads them. */
export type SerializedCommentCardNode = Spread<
  { quote: string; body: string },
  SerializedLexicalNode
>;

/**
 * A comment as a person's own turn shows it: the span it points at, quoted, and
 * the words about it. Read-only — the card is the record of a comment, not the
 * place it is edited — so it holds the text the surface gave it and no behaviour.
 */
export class CommentCardNode extends DecoratorNode<ReactElement> {
  __quote: string;
  __body: string;

  static override getType(): string {
    return 'doric-comment-card';
  }

  static override clone(node: CommentCardNode): CommentCardNode {
    return new CommentCardNode(node.__quote, node.__body, node.__key);
  }

  static override importJSON(
    serialized: SerializedCommentCardNode,
  ): CommentCardNode {
    return $createCommentCardNode(serialized.quote, serialized.body);
  }

  constructor(quote: string, body: string, key?: NodeKey) {
    super(key);
    this.__quote = quote;
    this.__body = body;
  }

  getQuote(): string {
    return this.getLatest().__quote;
  }

  getBody(): string {
    return this.getLatest().__body;
  }

  override exportJSON(): SerializedCommentCardNode {
    return { ...super.exportJSON(), quote: this.__quote, body: this.__body };
  }

  override createDOM(): HTMLElement {
    const dom = document.createElement('div');
    dom.className = 'doric-comment-card';
    // A comment is not prose beside it: a caret has no position in the card, and
    // dragging a selection across the answer must not pick the card up with it.
    dom.contentEditable = 'false';
    dom.style.userSelect = 'none';
    return dom;
  }

  /** The card is read-only, so its element is never rebuilt. */
  override updateDOM(): false {
    return false;
  }

  override decorate(): ReactElement {
    return <CommentCard quote={this.getQuote()} body={this.getBody()} />;
  }

  /** A block decorator: an inline one would be a caret stop inside prose. */
  override isInline(): false {
    return false;
  }
}

/** Builds the field for the pending comment `commentId`. */
export const $createCommentFieldNode = (commentId: string): CommentFieldNode =>
  $applyNodeReplacement(new CommentFieldNode(commentId));

/** Builds the read-only card for a comment's `quote` and `body`. */
export const $createCommentCardNode = (
  quote: string,
  body: string,
): CommentCardNode => $applyNodeReplacement(new CommentCardNode(quote, body));

export const $isCommentFieldNode = (
  node: LexicalNode,
): node is CommentFieldNode => node instanceof CommentFieldNode;

export const $isCommentCardNode = (
  node: LexicalNode,
): node is CommentCardNode => node instanceof CommentCardNode;
