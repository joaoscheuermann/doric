import {
  $applyNodeReplacement,
  addClassNamesToElement,
  type EditorConfig,
  type LexicalNode,
  type NodeKey,
  type SerializedTextNode,
  type Spread,
  TextNode,
} from 'lexical';

/**
 * A run of an answer a person has commented on, as the document holds it: the
 * model's own words, tagged with the comment they belong to.
 *
 * It is content rather than chrome — a comment points at words the document
 * already holds — so it stays a `TextNode` and the prose around it keeps
 * reading as prose. What makes it different is that the person may not edit it:
 * the span is the model's, and a comment is edited through the field the
 * surface attaches to it, never by typing into the answer.
 */

/** The class `styles.css` styles, and the attribute the surface finds a span by. */
const CLASS_NAME = 'doric-commented-text';
const ATTRIBUTE = 'data-doric-comment';

export type SerializedCommentedText = Spread<
  { commentId: string },
  SerializedTextNode
>;

/**
 * The comment id a serialized span carries. A span written by an older surface
 * has none, and one rebuilt from the log gets it again, so an absent id is not
 * an error — it is a span the surface has not reattached to a comment yet.
 */
const commentIdIn = (serialized: SerializedTextNode): string =>
  (serialized as SerializedCommentedText).commentId ?? '';

export class CommentedTextNode extends TextNode {
  __commentId: string;

  static override getType(): string {
    return 'doric-commented-text';
  }

  /**
   * A hand-written clone, like every node class here: Lexical synthesizes one
   * for a class that does not own it, and the synthesized clone builds the node
   * with no arguments. The text fields are carried by `afterCloneFrom`; the
   * comment id is not a field the text schema knows, so it is copied here.
   */
  static override clone(node: CommentedTextNode): CommentedTextNode {
    return new CommentedTextNode(node.__text, node.__commentId, node.__key);
  }

  /**
   * The text fields come from the base node; the comment id is read from the
   * JSON when it is there, so a copy or an undo keeps a commented span attached
   * to its comment.
   */
  static override importJSON(
    serialized: SerializedTextNode,
  ): CommentedTextNode {
    return $createCommentedTextNode(
      serialized.text,
      commentIdIn(serialized),
    ).updateFromJSON(serialized);
  }

  constructor(text?: string, commentId?: string, key?: NodeKey) {
    super(text, key);
    this.__commentId = commentId ?? '';
  }

  override exportJSON(): SerializedCommentedText {
    return { ...super.exportJSON(), commentId: this.__commentId };
  }

  getCommentId(): string {
    return this.getLatest().__commentId;
  }

  setCommentId(value: string): this {
    const node = this.getWritable();
    node.__commentId = value;
    return node;
  }

  override createDOM(config: EditorConfig): HTMLElement {
    const dom = super.createDOM(config);
    addClassNamesToElement(dom, CLASS_NAME);
    // The id travels on the element, so the surface can find the span a comment
    // points at from the DOM alone, without walking the document.
    dom.setAttribute(ATTRIBUTE, this.__commentId);
    return dom;
  }

  /**
   * The element is rebuilt only when the span moves to another comment; every
   * other change — the model rewriting its words — is written in place, so the
   * span, and the surface's handle on it, survive.
   */
  override updateDOM(
    previous: this,
    dom: HTMLElement,
    config: EditorConfig,
  ): boolean {
    if (previous.__commentId !== this.__commentId) return true;
    return super.updateDOM(previous, dom, config);
  }

  /** A comment's words are the model's, so nothing may be typed before them. */
  override canInsertTextBefore(): false {
    return false;
  }

  override canInsertTextAfter(): false {
    return false;
  }

  /**
   * Not simple text: the span is tagged, so it must never be merged into the
   * run of plain text beside it and lose the comment it stands for.
   */
  override isSimpleText(): false {
    return false;
  }
}

/** Builds a commented span of `text` attached to the comment `commentId`. */
export const $createCommentedTextNode = (
  text: string,
  commentId: string,
): CommentedTextNode =>
  $applyNodeReplacement(new CommentedTextNode(text, commentId));

export const $isCommentedTextNode = (
  node: LexicalNode,
): node is CommentedTextNode => node instanceof CommentedTextNode;
