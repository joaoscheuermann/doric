import {
  $getRoot,
  ElementNode,
  type LexicalNode,
  type NodeKey,
  type SerializedElementNode,
  type Spread,
} from 'lexical';

import {
  PROMPT_INPUT_ATTRIBUTE,
  USER_PROMPT_BLOCK,
} from '../../../../domain/conversation-nodes.js';
import { CONVERSATION_FONT_CLASS } from './conversation-font.js';
import {
  applyTurnAvatar,
  sameTurnAvatar,
  type TurnAvatar,
} from './turn-avatar.js';

const placeholder = 'Ask the agent to search, edit or build in this project…';

export type SerializedUserPromptNode = Spread<
  { avatar?: TurnAvatar },
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
 *
 * The reader's own author line trails it, below it, added by the sync that owns
 * the conversation's blocks — the prompt is the reader's next turn, so it wears
 * the same footer a turn does, and the same mark in the gutter. The block is
 * only as tall as its text, so that line hugs the input rather than the bottom
 * of an empty box.
 */
export class UserPromptNode extends ElementNode {
  /** The mark the block draws in the gutter, or `null` for none. */
  __avatar: TurnAvatar;

  static override getType(): string {
    return USER_PROMPT_BLOCK;
  }

  static override clone(node: UserPromptNode): UserPromptNode {
    return new UserPromptNode(node.__avatar, node.__key);
  }

  constructor(avatar: TurnAvatar = null, key?: NodeKey) {
    super(key);
    this.__avatar = avatar;
  }

  override createDOM(): HTMLElement {
    const dom = document.createElement('div');
    dom.className = `outline-none ${CONVERSATION_FONT_CLASS}`;
    // The rail's last handle finds the input by this, the way a prompt's block
    // is found by the `data-prompt-id` its turn carries.
    dom.setAttribute(PROMPT_INPUT_ATTRIBUTE, '');
    this.$applyPlaceholder(dom);
    applyTurnAvatar(dom, this.__avatar);
    return dom;
  }

  /**
   * The placeholder is a property of the block, not of one of its children, so
   * it is re-derived whenever the block is reconciled — which typing marks it
   * dirty, because the text is inserted into it. The mark is written again in
   * place the same way, so a sync that only changes who the prompt belongs to
   * keeps the element it already drew.
   */
  override updateDOM(_prevNode: this, dom: HTMLElement): boolean {
    this.$applyPlaceholder(dom);
    applyTurnAvatar(dom, this.__avatar);
    return false;
  }

  /** The mark the block wears in the gutter; the sync sets it, the block draws it. */
  setAvatar(avatar: TurnAvatar): void {
    if (sameTurnAvatar(this.__avatar, avatar)) return;
    this.getWritable().__avatar = avatar;
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
    return {
      ...super.exportJSON(),
      ...(this.__avatar === null ? {} : { avatar: this.__avatar }),
    };
  }

  static override importJSON(
    serialized: SerializedUserPromptNode,
  ): UserPromptNode {
    return $createUserPromptNode(serialized.avatar ?? null);
  }
}

export function $createUserPromptNode(
  avatar: TurnAvatar = null,
): UserPromptNode {
  return new UserPromptNode(avatar);
}

export function $isUserPromptNode(
  node: LexicalNode | null | undefined,
): node is UserPromptNode {
  return node instanceof UserPromptNode;
}

/**
 * The conversation's one prompt block, wherever it sits, or `undefined` before
 * one exists. It normally stands as the root's second-to-last child (right
 * above the reader's author line), so walking from the tail finds it in O(1).
 */
export function $getUserPromptNode(): UserPromptNode | undefined {
  for (
    let child = $getRoot().getLastChild();
    child !== null;
    child = child.getPreviousSibling()
  ) {
    if ($isUserPromptNode(child)) return child;
  }
  return undefined;
}
