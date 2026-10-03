/**
 * A prompt the host closed as a failure, as a block of the transcript: the run's
 * own words for why it stopped, at the point in the log it stopped at.
 *
 * Whether the block reads as a quiet failure or as a warning is the code's
 * business, decided in `@/domain/prompt-lifecycle`; this only draws it where the
 * log put it.
 */
import { FailureNotice } from '@/components/molecules/failure-notice';
import { WidgetFocus } from '@/components/molecules/widget-focus';
import { FAILURE_TURN_BLOCK } from '@/domain/conversation-nodes';
import type { FailureTurn } from '@/domain/projector';
import type { PromptFailure } from '@/domain/prompt-lifecycle';
import {
  DecoratorNode,
  type LexicalNode,
  type NodeKey,
  type SerializedLexicalNode,
  type Spread,
} from 'lexical';
import { JSX } from 'react/jsx-runtime';

import { CONVERSATION_FONT_CLASS } from './conversation-font';

export type SerializedFailureTurnNode = Spread<
  { turnKey: string; promptId: string; failure: PromptFailure },
  SerializedLexicalNode
>;

export class FailureTurnNode extends DecoratorNode<JSX.Element> {
  __turnKey: string;
  __promptId: string;
  __failure: PromptFailure;

  constructor(
    turnKey: string,
    promptId: string,
    failure: PromptFailure,
    key?: NodeKey,
  ) {
    super(key);
    this.__turnKey = turnKey;
    this.__promptId = promptId;
    this.__failure = failure;
  }

  static override getType(): string {
    return FAILURE_TURN_BLOCK;
  }

  static override clone(node: FailureTurnNode): FailureTurnNode {
    return new FailureTurnNode(
      node.__turnKey,
      node.__promptId,
      node.__failure,
      node.__key,
    );
  }

  override createDOM(): HTMLElement {
    const dom = document.createElement('div');
    // `mt-6`: the gap the conversation's blocks stand apart by, which the author
    // line's bottom margin gives every other case. A failure follows a run that
    // carries no such line, so the gap is stated here.
    dom.className = `mt-6 ${CONVERSATION_FONT_CLASS}`;
    return dom;
  }

  override updateDOM(): boolean {
    return false;
  }

  /**
   * A block, not an inline widget. `DecoratorNode` reports inline by default,
   * and the rich-text root then wraps an inline child in a `ParagraphNode` —
   * which hides this block from the sync that keeps the transcript in step.
   */
  override isInline(): boolean {
    return false;
  }

  override decorate(): JSX.Element {
    return (
      <WidgetFocus nodeKey={this.__key}>
        {() => <FailureNotice failure={this.__failure} />}
      </WidgetFocus>
    );
  }

  /**
   * Take the chat's latest reading of the failure. The projection reuses the
   * failure object while nothing about it changed, so an unchanged block is not
   * drawn again.
   */
  setTurn(turn: FailureTurn): void {
    if (this.__failure === turn.failure) return;
    this.getWritable().__failure = turn.failure;
  }

  override exportJSON(): SerializedFailureTurnNode {
    return {
      ...super.exportJSON(),
      turnKey: this.__turnKey,
      promptId: this.__promptId,
      failure: this.__failure,
    };
  }

  static override importJSON(
    serialized: SerializedFailureTurnNode,
  ): FailureTurnNode {
    return $createFailureTurnNode(
      serialized.turnKey,
      serialized.promptId,
      serialized.failure,
    );
  }
}

export function $createFailureTurnNode(
  turnKey: string,
  promptId: string,
  failure: PromptFailure,
): FailureTurnNode {
  return new FailureTurnNode(turnKey, promptId, failure);
}

export function $isFailureTurnNode(
  node: LexicalNode | null | undefined,
): node is FailureTurnNode {
  return node instanceof FailureTurnNode;
}
