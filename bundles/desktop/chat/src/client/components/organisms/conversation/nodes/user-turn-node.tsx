import {
  ElementNode,
  type LexicalNode,
  type NodeKey,
  type SerializedElementNode,
  type Spread,
} from 'lexical';

import { USER_TURN_BLOCK } from '../../../../domain/conversation-nodes.js';
import type { DelegatedInput } from '../../../../domain/delegated.js';
import type { UserTurn } from '../../../../domain/projector.js';
import { CONVERSATION_FONT_CLASS } from './conversation-font.js';
import { $appendMarkdown } from './markdown-blocks.js';
import {
  applyTurnAvatar,
  sameTurnAvatar,
  type TurnAvatar,
} from './turn-avatar.js';

/**
 * How a prompt the host has not accepted yet is drawn: the reader's own words,
 * present but not yet a turn of the conversation.
 */
const PENDING_CLASS = 'opacity-50';

/**
 * Says the block's mark moved to the comments that open it: the sheet then
 * draws the block without one (`styles.css`).
 */
const AVATAR_MOVED_ATTRIBUTE = 'data-turn-avatar-moved';

export type SerializedUserTurnNode = Spread<
  {
    turnKey: string;
    promptId: string;
    accepted: boolean;
    delegated?: DelegatedInput;
    avatar?: TurnAvatar;
    avatarMoved?: true;
  },
  SerializedElementNode
>;

/**
 * The human's prompt as an editable block — or another Thread's input, when
 * `delegated` is set. The text lives as a child node, so the editor owns it:
 * selection, typing and undo all work on it like any other rich text.
 * The text lives as child nodes, so the editor owns it: selection, typing and
 * undo all work on it like any other rich text — and those children are the
 * markdown the reader wrote, read as blocks with their markers kept, so a prompt
 * reads in the transcript the way it was written and the way it read in the
 * input.
 *
 * A prompt the host has not accepted yet is drawn dimmed. That block is only
 * ever the reader's words sent a moment ago, drawn before the log holds them,
 * and the accepted turn the log carries is a block of its own — so `accepted` is
 * fixed per block and never has to be repainted.
 */
export class UserTurnNode extends ElementNode {
  __turnKey: string;
  __promptId: string;
  __delegated?: DelegatedInput;
  __accepted: boolean;
  /** The markdown the chat last wrote, so an edit by the reader survives a sync. */
  __synced: string;
  /** The text the children were last built into, for the same guard. */
  __written: string;
  /** The mark the block draws in the gutter, or `null` for none. */
  __avatar: TurnAvatar;
  /**
   * Whether the comments that open the block wear its mark in its place, so
   * the block's own words wear none.
   */
  __avatarMoved = false;

  constructor(
    turnKey: string,
    promptId: string,
    delegated: DelegatedInput | undefined,
    text: string,
    written: string,
    accepted: boolean,
    avatar: TurnAvatar = null,
    key?: NodeKey,
  ) {
    super(key);
    this.__turnKey = turnKey;
    this.__promptId = promptId;
    this.__delegated = delegated;
    this.__accepted = accepted;
    this.__synced = text.trim();
    this.__written = written;
    this.__avatar = avatar;
  }

  static override getType(): string {
    return USER_TURN_BLOCK;
  }

  static override clone(node: UserTurnNode): UserTurnNode {
    return new UserTurnNode(
      node.__turnKey,
      node.__promptId,
      node.__delegated,
      node.__synced,
      node.__written,
      node.__accepted,
      node.__avatar,
      node.__key,
    );
  }

  override afterCloneFrom(previous: this): void {
    super.afterCloneFrom(previous);
    this.__avatarMoved = previous.__avatarMoved;
  }

  override createDOM(): HTMLElement {
    const dom = document.createElement('div');
    dom.dataset.promptId = this.__promptId;
    dom.className = this.__accepted
      ? CONVERSATION_FONT_CLASS
      : `${CONVERSATION_FONT_CLASS} ${PENDING_CLASS}`;
    applyTurnAvatar(dom, this.__avatar);
    if (this.__avatarMoved) dom.setAttribute(AVATAR_MOVED_ATTRIBUTE, '');
    return dom;
  }

  /**
   * The mark is attributes and custom properties on the element the block
   * already drew, so it is written again in place and the element is kept: the
   * markdown children are never rebuilt to repaint a gutter. A block made dirty
   * by anything else — a streamed delta, a keystroke — keeps the mark it wears
   * untouched, so its subtree is not restyled for nothing.
   */
  override updateDOM(prevNode: this, dom: HTMLElement): boolean {
    if (!sameTurnAvatar(prevNode.__avatar, this.__avatar))
      applyTurnAvatar(dom, this.__avatar);
    if (prevNode.__avatarMoved !== this.__avatarMoved)
      dom.toggleAttribute(AVATAR_MOVED_ATTRIBUTE, this.__avatarMoved);
    return false;
  }

  /** The mark the block wears in the gutter; the sync sets it, the block draws it. */
  setAvatar(avatar: TurnAvatar): void {
    if (sameTurnAvatar(this.__avatar, avatar)) return;
    this.getWritable().__avatar = avatar;
  }

  /**
   * Whether the comments that open the block wear its mark: the sync that
   * seats them says so, and the block's words then wear none.
   */
  setAvatarMoved(moved: boolean): void {
    if (this.getLatest().__avatarMoved === moved) return;
    this.getWritable().__avatarMoved = moved;
  }

  override isInline(): boolean {
    return false;
  }

  /**
   * Take the chat's latest markdown, unless the reader has edited this block
   * since the last sync — then their words win and the chat leaves it alone. The
   * children are rebuilt from the source as the markdown says they should be,
   * never rewritten: what the block holds is still what the reader wrote.
   */
  setTurn(turn: UserTurn): void {
    const value = turn.text.trim();
    if (value === this.__synced) return;

    // The reader's own words win: a block they edited keeps what they wrote.
    if (this.getTextContent() !== this.__written) return;

    const writable = this.getWritable();
    writable.clear();
    writable.__synced = value;
    if (value.length > 0) $appendMarkdown(writable, value);
    writable.__written = writable.getTextContent();
  }

  override exportJSON(): SerializedUserTurnNode {
    return {
      ...super.exportJSON(),
      turnKey: this.__turnKey,
      promptId: this.__promptId,
      accepted: this.__accepted,
      ...(this.__delegated === undefined
        ? {}
        : { delegated: this.__delegated }),
      ...(this.__avatar === null ? {} : { avatar: this.__avatar }),
      ...(this.__avatarMoved ? { avatarMoved: true as const } : {}),
    };
  }

  static override importJSON(serialized: SerializedUserTurnNode): UserTurnNode {
    const node = $createUserTurnNode(
      serialized.turnKey,
      serialized.promptId,
      serialized.delegated,
      '',
      serialized.accepted,
      serialized.avatar ?? null,
    );
    node.__avatarMoved = serialized.avatarMoved === true;
    return node;
  }
}

export function $createUserTurnNode(
  turnKey: string,
  promptId: string,
  delegated: DelegatedInput | undefined,
  text: string,
  accepted: boolean,
  avatar: TurnAvatar = null,
): UserTurnNode {
  const value = text.trim();
  const node = new UserTurnNode(
    turnKey,
    promptId,
    delegated,
    value,
    '',
    accepted,
    avatar,
  );
  if (value.length > 0) $appendMarkdown(node, value);
  node.__written = node.getTextContent();
  return node;
}

export function $isUserTurnNode(
  node: LexicalNode | null | undefined,
): node is UserTurnNode {
  return node instanceof UserTurnNode;
}
