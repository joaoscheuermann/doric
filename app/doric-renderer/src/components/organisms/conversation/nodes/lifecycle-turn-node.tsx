/**
 * A prompt's pause or resume as a block of the transcript: a quiet row between
 * the blocks the event sits between, drawn from the lifecycle rules so the row
 * never invents its own wording. The caret skips this informational block,
 * and its Retomar button is the only thing in it that acts.
 */
import { PromptMarker } from '@/components/molecules/prompt-marker';
import { LIFECYCLE_TURN_BLOCK } from '@/domain/conversation-nodes';
import type { LifecycleTurn } from '@/domain/projector';
import type { LifecycleEvent } from '@/domain/prompt-lifecycle';
import {
  DecoratorNode,
  type LexicalNode,
  type NodeKey,
  type SerializedLexicalNode,
  type Spread,
} from 'lexical';
import { JSX } from 'react/jsx-runtime';

import { CONVERSATION_FONT_CLASS } from './conversation-font';

export type SerializedLifecycleTurnNode = Spread<
  { turnKey: string; promptId: string; event: LifecycleEvent },
  SerializedLexicalNode
>;

/**
 * What a marker's Retomar action asks for. The surface hands the node the one
 * bound to its Thread, so the row never names the Thread itself.
 */
export type ResumePrompt = (promptId: string) => void;

/** The action of a node rebuilt without a surface to hand it one. */
const noResume: ResumePrompt = () => undefined;

export class LifecycleTurnNode extends DecoratorNode<JSX.Element> {
  __turnKey: string;
  __promptId: string;
  __event: LifecycleEvent;
  /** The surface's Retomar action; carried through clones, never serialized. */
  __onResume: ResumePrompt;

  constructor(
    turnKey: string,
    promptId: string,
    event: LifecycleEvent,
    onResume: ResumePrompt,
    key?: NodeKey,
  ) {
    super(key);
    this.__turnKey = turnKey;
    this.__promptId = promptId;
    this.__event = event;
    this.__onResume = onResume;
  }

  static override getType(): string {
    return LIFECYCLE_TURN_BLOCK;
  }

  static override clone(node: LifecycleTurnNode): LifecycleTurnNode {
    return new LifecycleTurnNode(
      node.__turnKey,
      node.__promptId,
      node.__event,
      node.__onResume,
      node.__key,
    );
  }

  override createDOM(): HTMLElement {
    const dom = document.createElement('div');
    dom.className = `my-4 select-none ${CONVERSATION_FONT_CLASS}`;
    return dom;
  }

  override updateDOM(): boolean {
    return false;
  }

  /**
   * A block, not an inline widget. `DecoratorNode` reports inline by default,
   * and the rich-text root then wraps an inline child in a `ParagraphNode` —
   * which hides this row from the sync that keeps the transcript in step.
   */
  override isInline(): boolean {
    return false;
  }

  override isKeyboardSelectable(): boolean {
    return false;
  }

  override decorate(): JSX.Element {
    return (
      <PromptMarker
        event={this.__event}
        onResume={() => this.__onResume(this.__promptId)}
      />
    );
  }

  /**
   * Take the chat's latest reading of the event. The projection reuses the event
   * object while nothing about the pause changed, so an unchanged row is not
   * drawn again and a pause that stopped standing takes the new reading.
   */
  setTurn(turn: LifecycleTurn): void {
    if (this.__event === turn.lifecycle) return;
    this.getWritable().__event = turn.lifecycle;
  }

  override exportJSON(): SerializedLifecycleTurnNode {
    return {
      ...super.exportJSON(),
      turnKey: this.__turnKey,
      promptId: this.__promptId,
      event: this.__event,
    };
  }

  static override importJSON(
    serialized: SerializedLifecycleTurnNode,
  ): LifecycleTurnNode {
    return $createLifecycleTurnNode(
      serialized.turnKey,
      serialized.promptId,
      serialized.event,
      noResume,
    );
  }
}

export function $createLifecycleTurnNode(
  turnKey: string,
  promptId: string,
  event: LifecycleEvent,
  onResume: ResumePrompt,
): LifecycleTurnNode {
  return new LifecycleTurnNode(turnKey, promptId, event, onResume);
}

export function $isLifecycleTurnNode(
  node: LexicalNode | null | undefined,
): node is LifecycleTurnNode {
  return node instanceof LifecycleTurnNode;
}
