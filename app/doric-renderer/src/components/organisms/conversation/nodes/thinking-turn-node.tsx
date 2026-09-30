import { THINKING_TURN_BLOCK } from '@/domain/conversation-nodes';
import type { ThinkingTurn } from '@/domain/projector';
import {
  DecoratorNode,
  type LexicalNode,
  type NodeKey,
  type SerializedLexicalNode,
  type Spread,
} from 'lexical';
import { JSX } from 'react/jsx-runtime';

import { CONVERSATION_FONT_CLASS } from './conversation-font';

export type SerializedThinkingTurnNode = Spread<
  { turnKey: string; promptId: string; text: string },
  SerializedLexicalNode
>;

/** A run of the agent's reasoning: a read-only widget, not editable text. */
export class ThinkingTurnNode extends DecoratorNode<JSX.Element> {
  __turnKey: string;
  __promptId: string;
  __text: string;

  constructor(turnKey: string, promptId: string, text: string, key?: NodeKey) {
    super(key);
    this.__turnKey = turnKey;
    this.__promptId = promptId;
    this.__text = text.trim();
  }

  static override getType(): string {
    return THINKING_TURN_BLOCK;
  }

  static override clone(node: ThinkingTurnNode): ThinkingTurnNode {
    return new ThinkingTurnNode(
      node.__turnKey,
      node.__promptId,
      node.__text,
      node.__key,
    );
  }

  override createDOM(): HTMLElement {
    const dom = document.createElement('div');
    dom.className = CONVERSATION_FONT_CLASS;
    return dom;
  }

  override updateDOM(): boolean {
    return false;
  }

  /**
   * A block, not an inline widget. `DecoratorNode` reports inline by default,
   * and the rich-text root then wraps an inline child in a `ParagraphNode` —
   * which hides this turn from the sync that keeps the transcript in step, so
   * it is re-created on every update and the author line that should trail the
   * run lands on the wrong turn.
   */
  override isInline(): boolean {
    return false;
  }

  override decorate(): JSX.Element {
    return <div>{this.__text}</div>;
  }

  setTurn(turn: ThinkingTurn): void {
    const value = turn.text.trim();
    if (this.__text !== value) this.getWritable().__text = value;
  }

  override exportJSON(): SerializedThinkingTurnNode {
    return {
      ...super.exportJSON(),
      turnKey: this.__turnKey,
      promptId: this.__promptId,
      text: this.__text,
    };
  }

  static override importJSON(
    serialized: SerializedThinkingTurnNode,
  ): ThinkingTurnNode {
    return $createThinkingTurnNode(
      serialized.turnKey,
      serialized.promptId,
      serialized.text,
    );
  }
}

export function $createThinkingTurnNode(
  turnKey: string,
  promptId: string,
  text: string,
): ThinkingTurnNode {
  return new ThinkingTurnNode(turnKey, promptId, text);
}

export function $isThinkingTurnNode(
  node: LexicalNode | null | undefined,
): node is ThinkingTurnNode {
  return node instanceof ThinkingTurnNode;
}
