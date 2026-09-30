import type { AgentTurn, PromptStatus } from '@/domain/projector';
import {
  $createTextNode,
  ElementNode,
  type LexicalNode,
  type NodeKey,
  type SerializedElementNode,
  type Spread,
} from 'lexical';

export type SerializedAgentTurnNode = Spread<
  { turnKey: string; promptId: string; status: PromptStatus },
  SerializedElementNode
>;

/**
 * A run of the agent's answer as an editable block. The text lives as a child
 * node, so the reader can edit it; the chat keeps writing into it while the
 * job streams, and stops once the reader changes it.
 */
export class AgentTurnNode extends ElementNode {
  __turnKey: string;
  __promptId: string;
  __status: PromptStatus;
  /** The text the chat last wrote, so an edit by the reader survives a sync. */
  __synced: string;

  constructor(
    turnKey: string,
    promptId: string,
    status: PromptStatus,
    text: string,
    key?: NodeKey,
  ) {
    super(key);
    this.__turnKey = turnKey;
    this.__promptId = promptId;
    this.__status = status;
    this.__synced = text.trim();
  }

  static override getType(): string {
    return 'agent-turn-node';
  }

  static override clone(node: AgentTurnNode): AgentTurnNode {
    return new AgentTurnNode(
      node.__turnKey,
      node.__promptId,
      node.__status,
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

  /** Record the job's lifecycle; the status never depends on the reader. */
  setStatus(status: PromptStatus): void {
    if (this.__status === status) return;
    this.getWritable().__status = status;
  }

  /** Take the chat's latest text, unless the reader has edited this block. */
  setTurn(turn: AgentTurn): void {
    const writable = this.getWritable();
    if (writable.__status !== turn.status) writable.__status = turn.status;
    if (this.getTextContent() !== this.__synced) return;
    const value = turn.text.trim();
    writable.clear();
    if (value.length > 0) writable.append($createTextNode(value));
    writable.__synced = value;
  }

  override exportJSON(): SerializedAgentTurnNode {
    return {
      ...super.exportJSON(),
      turnKey: this.__turnKey,
      promptId: this.__promptId,
      status: this.__status,
    };
  }

  static override importJSON(
    serialized: SerializedAgentTurnNode,
  ): AgentTurnNode {
    return $createAgentTurnNode(
      serialized.turnKey,
      serialized.promptId,
      serialized.status,
      '',
    );
  }
}

export function $createAgentTurnNode(
  turnKey: string,
  promptId: string,
  status: PromptStatus,
  text: string,
): AgentTurnNode {
  const value = text.trim();
  const node = new AgentTurnNode(turnKey, promptId, status, value);
  if (value.length > 0) node.append($createTextNode(value));
  return node;
}

export function $isAgentTurnNode(
  node: LexicalNode | null | undefined,
): node is AgentTurnNode {
  return node instanceof AgentTurnNode;
}
