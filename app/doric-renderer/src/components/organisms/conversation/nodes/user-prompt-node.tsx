import { READER_AVATAR_CLASS } from '@/components/molecules/reader-avatar';
import { READER_NAME } from '@/domain/conversation-authors';
import { USER_PROMPT_BLOCK } from '@/domain/conversation-nodes';
import { identiconSvg } from '@/utility/identicon';
import { cn } from '@/utility/utils';
import {
  type ElementDOMSlot,
  ElementNode,
  type LexicalNode,
  type NodeKey,
  type SerializedElementNode,
  type Spread,
} from 'lexical';

import { CONVERSATION_FONT_CLASS } from './conversation-font';

const placeholder = 'Enter some rich text…';

/** Marks the element the prompt's text lives in, so it can be found again. */
const CONTENT_ATTR = 'data-prompt-content';

/**
 * The mark beside the prompt sits a step above the caption's — it stands on its
 * own rather than labelling a turn already read — but only a step: the input is
 * what the reader is looking at.
 */
const PROMPT_AVATAR_SIZE = 'size-5';

/**
 * One line of the prompt's text, `text-sm`'s line box. The avatar is centred in
 * a box this tall so its middle meets the first line's middle, whatever size
 * the mark is.
 */
const FIRST_LINE_BOX = 'h-5';

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
 *
 * Beside those children sits the reader's avatar. The block is a row, not a
 * plain box: its own element wraps the avatar and an inner content element, and
 * `getDOMSlot` points the reconciler at the inner one, so the text is managed
 * exactly as it is in any other block while the avatar is left alone.
 */
export class UserPromptNode extends ElementNode {
  static override getType(): string {
    return USER_PROMPT_BLOCK;
  }

  static override clone(node: UserPromptNode): UserPromptNode {
    return new UserPromptNode(node.__key);
  }

  constructor(key?: NodeKey) {
    super(key);
  }

  override createDOM(): HTMLElement {
    const dom = document.createElement('div');
    dom.className = 'flex items-start gap-2';
    dom.appendChild(this.createAvatar());

    const content = document.createElement('div');
    content.className = `min-h-24 flex-1 outline-none ${CONVERSATION_FONT_CLASS}`;
    content.setAttribute(CONTENT_ATTR, '');
    dom.appendChild(content);

    this.applyPlaceholder(content);
    return dom;
  }

  /**
   * The prompt's children are its text, which lives in the content element
   * beside the avatar; routing the reconciler there keeps it from mistaking the
   * avatar for a child it should reconcile.
   */
  override getDOMSlot(element: HTMLElement): ElementDOMSlot<HTMLElement> {
    return super.getDOMSlot(this.getContent(element));
  }

  /**
   * The placeholder is a property of the block, not of one of its children, so
   * it is re-derived whenever the block is reconciled — which typing marks it
   * dirty, because the text is inserted into it.
   */
  override updateDOM(_prevNode: this, dom: HTMLElement): boolean {
    this.applyPlaceholder(this.getContent(dom));
    return false;
  }

  override isInline(): boolean {
    return false;
  }

  private getContent(dom: HTMLElement): HTMLElement {
    const content = dom.querySelector<HTMLElement>(`[${CONTENT_ATTR}]`);
    if (content === null)
      throw new Error(
        'UserPromptNode: createDOM did not build its content element',
      );
    return content;
  }

  /** The reader's own mark, which the prompt wears because the reader writes it. */
  private createAvatar(): HTMLElement {
    const box = document.createElement('span');
    box.className = `flex shrink-0 items-center ${FIRST_LINE_BOX}`;

    const avatar = document.createElement('span');
    avatar.className = cn(READER_AVATAR_CLASS, PROMPT_AVATAR_SIZE);
    avatar.setAttribute('aria-hidden', 'true');
    avatar.innerHTML = identiconSvg(READER_NAME);
    box.appendChild(avatar);
    return box;
  }

  private applyPlaceholder(dom: HTMLElement): void {
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
