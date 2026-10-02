import { ThinkingItem } from '@/components/molecules/thinking-item';
import { WidgetFocus } from '@/components/molecules/widget-focus';
import {
  blockToggled,
  type Chosen,
  thinkingOpenness,
} from '@/domain/collapsible';
import { THINKING_TURN_BLOCK } from '@/domain/conversation-nodes';
import type { ThinkingTurn } from '@/domain/projector';
import { reasoningText } from '@/utility/reasoning-text';
import {
  $getNodeByKey,
  DecoratorNode,
  type LexicalEditor,
  type LexicalNode,
  type NodeKey,
  type SerializedLexicalNode,
  type Spread,
} from 'lexical';
import { JSX } from 'react/jsx-runtime';

import { CONVERSATION_FONT_CLASS } from './conversation-font';

export type SerializedThinkingTurnNode = Spread<
  { turnKey: string; promptId: string; text: string; streaming: boolean },
  SerializedLexicalNode
>;

/** A run of the agent's reasoning: a read-only widget, not editable text. */
export class ThinkingTurnNode extends DecoratorNode<JSX.Element> {
  __turnKey: string;
  __promptId: string;
  __text: string;
  /** Whether the run is still being written; the sync keeps it current. */
  __streaming: boolean;
  /** The reader's choice of open/closed; `null` until they make one. */
  __chosen: boolean | null = null;

  constructor(
    turnKey: string,
    promptId: string,
    text: string,
    streaming: boolean,
    key?: NodeKey,
  ) {
    super(key);
    this.__turnKey = turnKey;
    this.__promptId = promptId;
    this.__text = text.trim();
    this.__streaming = streaming;
  }

  static override getType(): string {
    return THINKING_TURN_BLOCK;
  }

  static override clone(node: ThinkingTurnNode): ThinkingTurnNode {
    return new ThinkingTurnNode(
      node.__turnKey,
      node.__promptId,
      node.__text,
      node.__streaming,
      node.__key,
    );
  }

  override createDOM(): HTMLElement {
    const dom = document.createElement('div');
    // `mt-6`: the gap the conversation's blocks stand apart by, which the author
    // line's bottom margin gives every other case. A step of a run can follow a
    // block that carries no such line, so the gap is stated here.
    dom.className = `mt-6 ${CONVERSATION_FONT_CLASS}`;
    return dom;
  }

  override updateDOM(): boolean {
    return false;
  }

  /**
   * The reader's choice of open/closed is theirs, not the sync's: it travels
   * with the block through every update a sync writes.
   */
  override afterCloneFrom(prevNode: this): void {
    super.afterCloneFrom(prevNode);
    this.__chosen = prevNode.__chosen;
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

  override decorate(editor: LexicalEditor): JSX.Element {
    return (
      <WidgetFocus nodeKey={this.__key}>
        {(focused) => (
          <ThinkingItem
            chosen={this.__chosen}
            focused={focused}
            onChosenChange={(chosen) =>
              editor.update(() => {
                const node = $getNodeByKey(this.__key);
                if ($isThinkingTurnNode(node)) node.setChosen(chosen);
              })
            }
            streaming={this.__streaming}
            text={this.__text}
          />
        )}
      </WidgetFocus>
    );
  }

  /** Write the reader's choice of open/closed. */
  setChosen(chosen: Chosen): void {
    if (this.__chosen === chosen) return;
    this.getWritable().__chosen = chosen;
  }

  /** The reader opens or closes the block: their next choice is its opposite. */
  toggle(): void {
    this.setChosen(
      blockToggled(
        this.__chosen,
        thinkingOpenness(reasoningText(this.__text), this.__streaming),
      ),
    );
  }

  setTurn(turn: ThinkingTurn): void {
    const value = turn.text.trim();
    const textChanged = this.__text !== value;
    const streamingChanged = this.__streaming !== turn.streaming;
    if (!textChanged && !streamingChanged) return;
    const writable = this.getWritable();
    if (textChanged) writable.__text = value;
    if (streamingChanged) writable.__streaming = turn.streaming;
  }

  override exportJSON(): SerializedThinkingTurnNode {
    return {
      ...super.exportJSON(),
      turnKey: this.__turnKey,
      promptId: this.__promptId,
      text: this.__text,
      streaming: this.__streaming,
    };
  }

  static override importJSON(
    serialized: SerializedThinkingTurnNode,
  ): ThinkingTurnNode {
    return $createThinkingTurnNode(
      serialized.turnKey,
      serialized.promptId,
      serialized.text,
      serialized.streaming,
    );
  }
}

export function $createThinkingTurnNode(
  turnKey: string,
  promptId: string,
  text: string,
  streaming: boolean,
): ThinkingTurnNode {
  return new ThinkingTurnNode(turnKey, promptId, text, streaming);
}

export function $isThinkingTurnNode(
  node: LexicalNode | null | undefined,
): node is ThinkingTurnNode {
  return node instanceof ThinkingTurnNode;
}
