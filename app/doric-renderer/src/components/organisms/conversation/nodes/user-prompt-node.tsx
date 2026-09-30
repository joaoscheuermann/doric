import {
  DecoratorNode,
  type LexicalNode,
  type NodeKey,
  type SerializedLexicalNode,
  type Spread,
} from 'lexical';
import { JSX } from 'react/jsx-runtime';

const USER_PROMPT_NODE_TYPE = 'user-prompt-node';

const placeholder = 'Enter some rich text…';

export type SerializedUserPromptNode = Spread<
  Record<never, never>,
  SerializedLexicalNode
>;

/**
 * The block the reader writes the next prompt in, and the last block of the
 * conversation so the transcript grows above it. For now it is only the box and
 * its placeholder: nothing reads what it holds yet.
 */
export class UserPromptNode extends DecoratorNode<JSX.Element> {
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
    return document.createElement('div');
  }

  override updateDOM(): boolean {
    return false;
  }

  /**
   * A block rather than an inline decorator. `DecoratorNode` defaults to inline,
   * which tucks the prompt inside a paragraph and hides it from the surface that
   * finds the prompt and keeps it last; as a block it sits beside the turn blocks
   * at the root, where that ordering works.
   */
  override isInline(): boolean {
    return false;
  }

  override decorate(): JSX.Element {
    return (
      <div className="relative">
        <div
          contentEditable
          suppressContentEditableWarning
          role="textbox"
          aria-label="Prompt"
          aria-placeholder={placeholder}
          className="min-h-24 px-3 py-2 outline-none"
        />
        <div className="pointer-events-none absolute top-2 left-3 select-none text-muted-foreground">
          {placeholder}
        </div>
      </div>
    );
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
