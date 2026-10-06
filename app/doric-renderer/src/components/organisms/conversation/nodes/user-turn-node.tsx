import {
  ElementNode,
  type LexicalNode,
  type NodeKey,
  type SerializedElementNode,
  type Spread,
} from 'lexical';

import { USER_TURN_BLOCK } from '@/domain/conversation-nodes';
import type { DelegatedInput } from '@/domain/delegated';
import type { UserTurn } from '@/domain/projector';

import { CONVERSATION_FONT_CLASS } from './conversation-font';
import { $appendMarkdown } from './markdown-blocks';

/**
 * How a prompt the host has not accepted yet is drawn: the reader's own words,
 * present but not yet a turn of the conversation.
 */
const PENDING_CLASS = 'opacity-50';

export type SerializedUserTurnNode = Spread<
  {
    turnKey: string;
    promptId: string;
    accepted: boolean;
    delegated?: DelegatedInput;
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

  constructor(
    turnKey: string,
    promptId: string,
    delegated: DelegatedInput | undefined,
    text: string,
    written: string,
    accepted: boolean,
    key?: NodeKey,
  ) {
    super(key);
    this.__turnKey = turnKey;
    this.__promptId = promptId;
    this.__delegated = delegated;
    this.__accepted = accepted;
    this.__synced = text.trim();
    this.__written = written;
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
      node.__key,
    );
  }

  override createDOM(): HTMLElement {
    const dom = document.createElement('div');
    dom.dataset.promptId = this.__promptId;
    dom.className = this.__accepted
      ? CONVERSATION_FONT_CLASS
      : `${CONVERSATION_FONT_CLASS} ${PENDING_CLASS}`;
    return dom;
  }

  override updateDOM(): boolean {
    return false;
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
    };
  }

  static override importJSON(serialized: SerializedUserTurnNode): UserTurnNode {
    return $createUserTurnNode(
      serialized.turnKey,
      serialized.promptId,
      serialized.delegated,
      '',
      serialized.accepted,
    );
  }
}

export function $createUserTurnNode(
  turnKey: string,
  promptId: string,
  delegated: DelegatedInput | undefined,
  text: string,
  accepted: boolean,
): UserTurnNode {
  const value = text.trim();
  const node = new UserTurnNode(
    turnKey,
    promptId,
    delegated,
    value,
    '',
    accepted,
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
