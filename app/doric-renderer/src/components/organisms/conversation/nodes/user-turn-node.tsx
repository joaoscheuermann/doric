import type { DelegatedInput } from '@/domain/delegated';
import type { UserTurn } from '@/domain/projector';
import {
  $createTextNode,
  ElementNode,
  type LexicalNode,
  type NodeKey,
  type SerializedElementNode,
  type Spread,
} from 'lexical';

export type SerializedUserTurnNode = Spread<
  { turnKey: string; promptId: string; delegated?: DelegatedInput },
  SerializedElementNode
>;

/**
 * The human's prompt as an editable block — or another Thread's input, when
 * `delegated` is set. The text lives as a child node, so the editor owns it:
 * selection, typing and undo all work on it like any other rich text.
 */
export class UserTurnNode extends ElementNode {
  __turnKey: string;
  __promptId: string;
  __delegated?: DelegatedInput;
  /** The text the chat last wrote, so an edit by the reader survives a sync. */
  __synced: string;

  constructor(
    turnKey: string,
    promptId: string,
    delegated: DelegatedInput | undefined,
    text: string,
    key?: NodeKey,
  ) {
    super(key);
    this.__turnKey = turnKey;
    this.__promptId = promptId;
    this.__delegated = delegated;
    this.__synced = text.trim();
  }

  static override getType(): string {
    return 'user-turn-node';
  }

  static override clone(node: UserTurnNode): UserTurnNode {
    return new UserTurnNode(
      node.__turnKey,
      node.__promptId,
      node.__delegated,
      node.__synced,
      node.__key,
    );
  }

  override createDOM(): HTMLElement {
    return document.createElement('div');
  }

  override updateDOM(): boolean {
    return false;
  }

  override isInline(): boolean {
    return false;
  }

  /**
   * Take the chat's latest text, unless the reader has edited this block since
   * the last sync — then their words win and the chat leaves it alone.
   */
  setTurn(turn: UserTurn): void {
    if (this.getTextContent() !== this.__synced) return;
    const value = turn.text.trim();
    const writable = this.getWritable();
    writable.clear();
    if (value.length > 0) writable.append($createTextNode(value));
    writable.__synced = value;
  }

  override exportJSON(): SerializedUserTurnNode {
    return {
      ...super.exportJSON(),
      turnKey: this.__turnKey,
      promptId: this.__promptId,
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
    );
  }
}

export function $createUserTurnNode(
  turnKey: string,
  promptId: string,
  delegated: DelegatedInput | undefined,
  text: string,
): UserTurnNode {
  const value = text.trim();
  const node = new UserTurnNode(turnKey, promptId, delegated, value);
  if (value.length > 0) node.append($createTextNode(value));
  return node;
}

export function $isUserTurnNode(
  node: LexicalNode | null | undefined,
): node is UserTurnNode {
  return node instanceof UserTurnNode;
}
