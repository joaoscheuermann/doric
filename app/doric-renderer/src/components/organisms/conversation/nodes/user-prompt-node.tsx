import {
  ElementNode,
  type LexicalNode,
  type NodeKey,
  type SerializedElementNode,
  type Spread,
} from 'lexical';

const USER_PROMPT_NODE_TYPE = 'user-prompt-node';

const placeholder = 'Enter some rich text…';

export type SerializedUserPromptNode = Spread<
  Record<never, never>,
  SerializedElementNode
>;

/**
 * The block the reader writes the next prompt in, and the last block of the
 * conversation so the transcript grows above it.
 *
 * The text lives as a child node, like the turn blocks', so the whole
 * conversation stays one editing host: the caret, typing and undo all belong to
 * the editor, and the caret crosses between a turn and the prompt the way it
 * crosses between two turns. It carries its placeholder only while it is empty,
 * so the reader types over it rather than on top of it.
 */
export class UserPromptNode extends ElementNode {
  static override getType(): string {
    return USER_PROMPT_NODE_TYPE;
  }

  static override clone(node: UserPromptNode): UserPromptNode {
    return new UserPromptNode(node.__key);
  }

  constructor(key?: NodeKey) {
    super(key);
  }

  override createDOM(): HTMLElement {
    const dom = document.createElement('div');
    dom.className = 'min-h-24 outline-none';
    this.$applyPlaceholder(dom);
    return dom;
  }

  /**
   * The placeholder is a property of the block, not of one of its children, so
   * it is re-derived whenever the block is reconciled — which typing marks it
   * dirty, because the text is inserted into it.
   */
  override updateDOM(_prevNode: this, dom: HTMLElement): boolean {
    this.$applyPlaceholder(dom);
    return false;
  }

  override isInline(): boolean {
    return false;
  }

  private $applyPlaceholder(dom: HTMLElement): void {
    if (this.getTextContent().length === 0)
      dom.setAttribute('data-placeholder', placeholder);
    else dom.removeAttribute('data-placeholder');
  }

  override exportJSON(): SerializedUserPromptNode {
    return super.exportJSON();
  }

  static override importJSON(): UserPromptNode {
    return $createUserPromptNode();
  }
}

export function $createUserPromptNode(): UserPromptNode {
  return new UserPromptNode();
}

export function $isUserPromptNode(
  node: LexicalNode | null | undefined,
): node is UserPromptNode {
  return node instanceof UserPromptNode;
}
