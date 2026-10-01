import { AGENT_TURN_BLOCK } from '@/domain/conversation-nodes';
import type { AgentTurn, PromptStatus } from '@/domain/projector';
import {
  ElementNode,
  type LexicalNode,
  type NodeKey,
  type SerializedElementNode,
  type Spread,
} from 'lexical';

import { CONVERSATION_FONT_CLASS } from './conversation-font';
import { $appendMarkdown } from './markdown-blocks';

export type SerializedAgentTurnNode = Spread<
  { turnKey: string; promptId: string; status: PromptStatus },
  SerializedElementNode
>;

/**
 * A run of the agent's answer as a block the reader can read and move the caret
 * through, but not edit: the chat owns the text. Its text lives as child nodes
 * so the caret reaches it like any other rich text, and those children are the
 * markdown the answer was written in — read as blocks, with every marker kept,
 * so the transcript styles what the model wrote instead of replacing it.
 */
export class AgentTurnNode extends ElementNode {
  __turnKey: string;
  __promptId: string;
  __status: PromptStatus;
  /** The markdown the chat last wrote, so an edit by the reader survives a sync. */
  __synced: string;
  /** The text the children were last built into, for the same guard. */
  __written: string;

  constructor(
    turnKey: string,
    promptId: string,
    status: PromptStatus,
    text: string,
    written: string,
    key?: NodeKey,
  ) {
    super(key);
    this.__turnKey = turnKey;
    this.__promptId = promptId;
    this.__status = status;
    this.__synced = text.trim();
    this.__written = written;
  }

  static override getType(): string {
    return AGENT_TURN_BLOCK;
  }

  static override clone(node: AgentTurnNode): AgentTurnNode {
    return new AgentTurnNode(
      node.__turnKey,
      node.__promptId,
      node.__status,
      node.__synced,
      node.__written,
      node.__key,
    );
  }

  override createDOM(): HTMLElement {
    const dom = document.createElement('div');
    // `mt-6`: the gap a turn stands from the one before it, which the author
    // line's bottom margin gives every other case. A summary before this answer
    // carries no bottom margin of its own, so the gap has to be stated here.
    dom.className = `mt-6 ${CONVERSATION_FONT_CLASS}`;
    return dom;
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

  /**
   * Take the chat's latest markdown, unless the reader has edited this block
   * since the last sync — then their words win and the chat leaves it alone. The
   * children are rebuilt from the source as the markdown says they should be,
   * never rewritten: what the block holds is still what the model wrote.
   */
  setTurn(turn: AgentTurn): void {
    const writable = this.getWritable();
    if (writable.__status !== turn.status) writable.__status = turn.status;

    const value = turn.text.trim();
    if (value === writable.__synced) return;
    if (this.getTextContent() !== writable.__written) return;

    writable.clear();
    writable.__synced = value;
    if (value.length > 0) $appendMarkdown(writable, value);
    writable.__written = writable.getTextContent();
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
  const node = new AgentTurnNode(turnKey, promptId, status, value, '');
  if (value.length > 0) $appendMarkdown(node, value);
  node.__written = node.getTextContent();
  return node;
}

export function $isAgentTurnNode(
  node: LexicalNode | null | undefined,
): node is AgentTurnNode {
  return node instanceof AgentTurnNode;
}
